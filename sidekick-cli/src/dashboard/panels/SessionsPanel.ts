/**
 * Sessions panel — consolidates MetricsPage + ProjectTimelinePage logic.
 * Shows active + historical sessions in the side list,
 * with detail tabs for Summary, Timeline, Tools, and Files.
 */

import type { SidePanel, PanelItem, PanelAction, DetailTab, KeyBinding } from './types';
import type { DashboardMetrics, ContextAttribution } from '../DashboardState';
import type { StaticData, SessionRecord } from '../StaticDataLoader';
import { fmtNum, formatDuration, formatElapsed, formatTime, makeBar, shortenPath, wordWrap, detailWidth, visibleLength, truncate } from '../formatters';
import { buildMindMapTree, renderMindMapBoxed, renderTreeToText } from '../MindMapBuilder';
import { GitDiffCache } from '../GitDiffCache';
import { CliInferenceClient } from '../../inference/CliInferenceClient';
import { buildNarrativePrompt } from '../../inference/narrativePrompt';
import type { ProviderId } from 'sidekick-shared';

type MindMapView = 'tree' | 'boxed' | 'flow';
type MindMapFilter = 'all' | 'file' | 'tool' | 'task' | 'subagent' | 'command' | 'plan' | 'knowledge-note';
const MINDMAP_FILTERS: MindMapFilter[] = ['all', 'file', 'tool', 'task', 'subagent', 'command', 'plan', 'knowledge-note'];

export class SessionsPanel implements SidePanel {
  readonly id = 'sessions';
  readonly title = 'Sessions';
  readonly shortcutKey = 1;
  private mindMapView: MindMapView = 'tree';
  private mindMapFilter: MindMapFilter = 'all';
  private diffCache: GitDiffCache | null;
  private inferenceClient: CliInferenceClient | null = null;
  private narrativeText: string | null = null;
  private narrativeLoading = false;
  private narrativeError: string | null = null;
  /** Set externally to trigger re-render after async narrative generation. */
  onNarrativeComplete?: () => void;

  constructor(workspacePath?: string, providerId?: ProviderId) {
    this.diffCache = workspacePath ? new GitDiffCache(workspacePath) : null;
    if (providerId) {
      this.inferenceClient = new CliInferenceClient(providerId);
      // Fire-and-forget availability check
      this.inferenceClient.checkAvailability().catch(() => { /* ignore */ });
    }
  }
  /** Set by PanelLayout to track which detail tab is active. */
  activeDetailTabIndex = 0;

  readonly detailTabs: DetailTab[] = [
    { label: 'Summary', render: (item, m) => this.renderSummary(item, m) },
    { label: 'Timeline', render: (item, m) => this.renderTimeline(item, m), autoScrollBottom: true },
    { label: 'Mind Map', render: (item, m, sd) => this.renderMindMap(item, m, sd) },
    { label: 'Tools', render: (item, m) => this.renderTools(item, m) },
    { label: 'Files', render: (item, m) => this.renderFiles(item, m) },
    { label: 'Agents', render: (item, m) => this.renderAgents(item, m) },
    { label: 'AI Summary', render: (item, m) => this.renderAiSummary(item, m) },
  ];

  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    const items: PanelItem[] = [];

    // Active session (always first)
    if (metrics.eventCount > 0) {
      const sessionId = (metrics.sessionStartTime || 'active').substring(0, 8);
      const providerSuffix = metrics.providerName ? ` (${metrics.providerName})` : '';
      const runningAgents = metrics.subagents.filter(a => a.status === 'running').length;
      const agentBadge = runningAgents > 0 ? ` {magenta-fg}[${runningAgents}\u229B]{/magenta-fg}` : '';
      items.push({
        id: 'active',
        label: `{green-fg}\u25CF{/green-fg} session-${sessionId}${providerSuffix}${agentBadge}`,
        sortKey: 0,
        data: { type: 'active', metrics },
      });
    }

    // Historical sessions from static data
    for (let i = staticData.sessions.length - 1; i >= 0; i--) {
      const s = staticData.sessions[i];
      items.push({
        id: `hist-${i}`,
        label: `  ${s.date} (${s.sessionCount})`,
        sortKey: i + 1,
        data: { type: 'historical', session: s },
      });
    }

    return items;
  }

  getActions(): PanelAction[] {
    return [];
  }

  getSearchableText(item: PanelItem): string {
    const d = item.data as { type: string; metrics?: DashboardMetrics; session?: SessionRecord };
    if (d.type === 'active' && d.metrics) {
      const parts = [
        ...d.metrics.toolStats.map(t => t.name),
        ...d.metrics.fileTouches.map(f => f.path),
        ...d.metrics.timeline.slice(-30).map(e => e.summary || ''),
        d.metrics.currentModel || '',
      ];
      return parts.join(' ');
    }
    if (d.type === 'historical' && d.session) {
      const s = d.session;
      return [s.date, ...s.modelUsage.map(m => m.model), ...s.toolUsage.map(t => t.tool)].join(' ');
    }
    return '';
  }

  getKeybindings(): KeyBinding[] {
    return [
      {
        keys: ['v'],
        label: 'cycle view',
        handler: () => {
          const modes: MindMapView[] = ['tree', 'boxed', 'flow'];
          const idx = modes.indexOf(this.mindMapView);
          this.mindMapView = modes[(idx + 1) % modes.length];
        },
        // Only active when Mind Map tab is selected (tab index 2)
        condition: () => this.activeDetailTabIndex === 2,
      },
      {
        keys: ['f'],
        label: 'filter nodes',
        handler: () => {
          const idx = MINDMAP_FILTERS.indexOf(this.mindMapFilter);
          this.mindMapFilter = MINDMAP_FILTERS[(idx + 1) % MINDMAP_FILTERS.length];
        },
        // Only active when Mind Map tab is selected (tab index 2)
        condition: () => this.activeDetailTabIndex === 2,
      },
      {
        keys: ['n'],
        label: 'AI narrative',
        handler: (_item?: PanelItem) => {
          this.generateNarrative();
        },
        // Only active when AI Summary tab is selected (tab index 6)
        condition: () => this.activeDetailTabIndex === 6,
      },
    ];
  }

  /** Trigger async AI narrative generation. */
  private generateNarrative(): void {
    if (!this.inferenceClient) {
      this.narrativeError = 'No inference client configured';
      this.onNarrativeComplete?.();
      return;
    }
    if (!this.inferenceClient.isAvailable) {
      this.narrativeError = this.inferenceClient.getEnableHint();
      this.onNarrativeComplete?.();
      return;
    }
    if (this.narrativeLoading) return;
    if (!this._lastMetrics) return;

    this.narrativeLoading = true;
    this.narrativeError = null;
    this.onNarrativeComplete?.();

    // We need metrics at generation time — store a reference via the last render
    const prompt = buildNarrativePrompt(this._lastMetrics, this.diffCache?.getStats());

    this.inferenceClient.complete(prompt).then(result => {
      this.narrativeLoading = false;
      if (result.error) {
        this.narrativeError = result.error;
      } else {
        this.narrativeText = result.text;
      }
      this.onNarrativeComplete?.();
    }).catch(err => {
      this.narrativeLoading = false;
      this.narrativeError = (err as Error).message;
      this.onNarrativeComplete?.();
    });
  }

  /** Stored reference to last metrics for async narrative generation. */
  private _lastMetrics: DashboardMetrics | null = null;

  // ── Detail tab renderers ──

  private renderAiSummary(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string };
    if (d.type !== 'active') {
      return '{grey-fg}(AI summary only available for active session){/grey-fg}';
    }

    this._lastMetrics = metrics;

    if (this.narrativeLoading) {
      return '{yellow-fg}Generating AI narrative...{/yellow-fg}';
    }

    if (this.narrativeError) {
      return `{red-fg}Error: ${this.narrativeError}{/red-fg}\n\n{grey-fg}Press 'n' to retry{/grey-fg}`;
    }

    if (this.narrativeText) {
      // Wrap to detail pane width (terminal minus side panel and borders)
      const wrapWidth = detailWidth();
      return '{bold}AI Session Narrative{/bold}\n\n' + wordWrap(this.narrativeText, wrapWidth);
    }

    const available = this.inferenceClient?.isAvailable ?? false;
    if (!available) {
      const hint = this.inferenceClient?.getEnableHint() ?? 'Configure inference provider';
      return `{grey-fg}AI narrative not available.\n\n${hint}{/grey-fg}`;
    }

    return [
      '{bold}AI Session Narrative{/bold}',
      '',
      '{grey-fg}Uses your active inference provider to generate a plain-English',
      'summary of this session — what was accomplished, patterns in tool',
      'and token usage, and suggestions for future sessions.{/grey-fg}',
      '',
      "Press {bold}n{/bold} to generate.",
    ].join('\n');
  }

  private renderSummary(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string; metrics?: DashboardMetrics; session?: SessionRecord };
    this._lastMetrics = metrics;

    if (d.type === 'active') {
      const m = metrics;
      const t = m.tokens;
      const c = m.context;
      const contextColor = c.percent < 60 ? 'green' : c.percent < 80 ? 'yellow' : 'red';
      const barWidth = 30;
      const filled = Math.round((c.percent / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

      const elapsed = m.sessionStartTime ? formatElapsed(m.sessionStartTime) : '--:--:--';

      // Burn rate sparkline
      const burnData = m.burnRate.length > 0 ? m.burnRate : [0];
      const latest = burnData[burnData.length - 1];
      const max = Math.max(...burnData, 1);
      const chars = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
      const spark = burnData.slice(-25).map(v => chars[Math.min(8, Math.round((v / max) * 8))]).join('');

      const runningAgents = m.subagents.filter(a => a.status === 'running').length;
      const completedAgents = m.subagents.filter(a => a.status === 'completed').length;
      const agentSummary = m.subagents.length > 0
        ? `${m.subagents.length} (${runningAgents} running, ${completedAgents} done)`
        : '0';

      // Most recent non-user, non-tool_result timeline event
      const recentEvent = [...m.timeline].reverse().find(
        e => e.type !== 'user' && e.type !== 'tool_result'
      );
      const recentLine = recentEvent
        ? (() => {
            const prefix = `[${formatTime(recentEvent.timestamp)}] ${recentEvent.type.padEnd(12)} `;
            const maxSummary = Math.max(20, detailWidth() - prefix.length);
            return `{yellow-fg}${prefix}${truncate(recentEvent.summary || '', maxSummary)}{/yellow-fg}`;
          })()
        : '{grey-fg}(no events yet){/grey-fg}';

      const lines = [
        '{bold}Active Session{/bold}',
        recentLine,
        '',
        `{bold}Elapsed:{/bold}      ${elapsed}`,
        `{bold}Provider:{/bold}     ${m.providerName || 'unknown'}`,
        `{bold}Model:{/bold}        ${m.currentModel || 'unknown'}`,
        `{bold}Events:{/bold}       ${m.eventCount}`,
        `{bold}Compactions:{/bold}  ${m.compactionCount}`,
        `{bold}Subagents:{/bold}   ${agentSummary}`,
        '',
        '{bold}Tokens{/bold}',
        `  Input:       ${fmtNum(t.input)}`,
        `  Output:      ${fmtNum(t.output)}`,
        `  Cache Read:  ${fmtNum(t.cacheRead)}`,
        `  Cache Write: ${fmtNum(t.cacheWrite)}`,
        ...(t.cacheRead + t.input > 0
          ? [`  Hit Rate:    ${((t.cacheRead / (t.cacheRead + t.input)) * 100).toFixed(1)}%`]
          : []),
        `  Cost:        {green-fg}$${t.cost.toFixed(4)}{/green-fg}`,
        '',
        '{bold}Context{/bold}',
        `  {${contextColor}-fg}${bar}{/${contextColor}-fg}`,
        `  {bold}${c.percent}%{/bold}  ${fmtNum(c.used)} / ${fmtNum(c.limit)}`,
      ];

      // Context history sparkline
      if (m.contextTimeline && m.contextTimeline.length > 1) {
        const ctxPoints = m.contextTimeline.slice(-25);
        const ctxMax = Math.max(...ctxPoints.map(p => p.inputTokens), 1);
        const sparkChars = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
        const ctxSpark = ctxPoints.map(p => sparkChars[Math.min(8, Math.round((p.inputTokens / ctxMax) * 8))]).join('');
        lines.push(`  {grey-fg}${ctxSpark}{/grey-fg}  history`);
      }

      // Permission mode
      if (m.permissionMode && m.permissionMode !== 'default') {
        const modeColors: Record<string, string> = { bypassPermissions: 'red', acceptEdits: 'magenta', plan: 'green' };
        const modeLabels: Record<string, string> = { bypassPermissions: 'Bypass Permissions', acceptEdits: 'Accept Edits', plan: 'Plan Mode' };
        const modeColor = modeColors[m.permissionMode] || 'grey';
        const modeLabel = modeLabels[m.permissionMode] || m.permissionMode;
        lines.push('', `{bold}Permission:{/bold}  {${modeColor}-fg}${modeLabel}{/${modeColor}-fg}`);
      }

      lines.push(
        '',
        '{bold}Burn Rate{/bold}',
        `  {cyan-fg}${spark}{/cyan-fg}  {bold}${fmtNum(latest)}{/bold} tok/min`,
      );

      // Task completion summary
      if (m.tasks.length > 0) {
        const completed = m.tasks.filter(t => t.status === 'completed').length;
        const active = m.tasks.filter(t => t.status === 'in_progress').length;
        const pending = m.tasks.filter(t => t.status === 'pending').length;
        lines.push('', '{bold}Tasks{/bold}');
        lines.push(`  ${completed}/${m.tasks.length} completed  ${active} active  ${pending} pending`);
      }

      // File change summary
      const diffStats = this.diffCache?.getStats() ?? new Map();
      if (diffStats.size > 0) {
        let totalAdd = 0, totalDel = 0;
        for (const s of diffStats.values()) {
          totalAdd += s.additions;
          totalDel += s.deletions;
        }
        lines.push('', '{bold}File Changes{/bold}');
        lines.push(`  ${diffStats.size} files touched  {green-fg}+${totalAdd}{/green-fg} {red-fg}-${totalDel}{/red-fg} lines`);
      }

      // Model cost breakdown
      if (m.modelStats.length > 0) {
        lines.push('', '{bold}Model Usage{/bold}');
        for (const ms of m.modelStats) {
          const modelName = ms.model.length > 20 ? ms.model.substring(0, 17) + '...' : ms.model;
          lines.push(`  ${modelName.padEnd(20)} ${String(ms.calls).padStart(4)} calls  {green-fg}$${ms.cost.toFixed(4)}{/green-fg}`);
        }
      }

      // Quota
      if (m.quota?.available) {
        const q = m.quota;
        lines.push('', '{bold}Quota{/bold}');
        const fiveColor = q.fiveHour.utilization < 60 ? 'green' : q.fiveHour.utilization < 80 ? 'yellow' : 'red';
        const fiveBar = makeBar(q.fiveHour.utilization, 18);
        lines.push(`  5h:  {${fiveColor}-fg}${fiveBar}{/${fiveColor}-fg} ${q.fiveHour.utilization.toFixed(0)}%`);
        const sevenColor = q.sevenDay.utilization < 60 ? 'green' : q.sevenDay.utilization < 80 ? 'yellow' : 'red';
        const sevenBar = makeBar(q.sevenDay.utilization, 18);
        lines.push(`  7d:  {${sevenColor}-fg}${sevenBar}{/${sevenColor}-fg} ${q.sevenDay.utilization.toFixed(0)}%`);
      }

      // Context Attribution
      const attrLines = renderContextAttribution(m.contextAttribution);
      if (attrLines.length > 0) {
        lines.push('', ...attrLines);
      }

      return lines.join('\n');
    }

    // Historical session
    const s = d.session!;
    const totalTokens = s.inputTokens + s.outputTokens;
    return [
      `{bold}${s.date}{/bold}`,
      '',
      `{bold}Sessions:{/bold}   ${s.sessionCount}`,
      `{bold}Tokens:{/bold}     ${fmtNum(totalTokens)} (${fmtNum(s.inputTokens)} in / ${fmtNum(s.outputTokens)} out)`,
      `{bold}Cost:{/bold}       {green-fg}$${s.totalCost.toFixed(4)}{/green-fg}`,
      `{bold}Messages:{/bold}   ${s.messageCount}`,
      '',
      '{bold}Models{/bold}',
      ...s.modelUsage.map(u => `  ${u.model}: ${u.calls} calls`),
      '',
      '{bold}Tools{/bold}',
      ...s.toolUsage.sort((a, b) => b.calls - a.calls).slice(0, 10).map(u =>
        `  ${u.tool.padEnd(16)} ${u.calls} calls`
      ),
    ].join('\n');
  }

  private renderTimeline(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string };
    if (d.type !== 'active') {
      return '{grey-fg}(timeline only available for active session){/grey-fg}';
    }

    const events = metrics.timeline.slice(-50);
    if (events.length === 0) return '{grey-fg}(no events yet){/grey-fg}';

    const w = detailWidth();
    return events.map(ev => {
      const time = formatTime(ev.timestamp);
      const color = EVENT_COLORS[ev.type] || 'white';
      const label = ev.type.padEnd(12);
      // Build suffix first so we know how much space is left for the summary
      let suffix = '';
      if (ev.tokens) {
        suffix = `  (${fmtNum(ev.tokens.input)} in / ${fmtNum(ev.tokens.output)} out)`;
        if (ev.cost) suffix += ` $${ev.cost.toFixed(4)}`;
      }
      // Prefix visible width: "[HH:MM:SS] event_type   " = ~23 chars
      const prefixLen = 1 + time.length + 2 + 12; // [time] + space + label
      const summaryMax = Math.max(10, w - prefixLen - suffix.length);
      const summary = truncate(ev.summary || '', summaryMax);
      let line = `{${color}-fg}[${time}] ${label}{/${color}-fg} ${summary}`;
      if (suffix) {
        line += `  {grey-fg}${suffix.trimStart()}{/grey-fg}`;
      }
      return line;
    }).join('\n');
  }

  private renderMindMap(item: PanelItem, metrics: DashboardMetrics, staticData: StaticData): string {
    const d = item.data as { type: string };
    if (d.type !== 'active') {
      return '{grey-fg}(mind map only available for active session){/grey-fg}';
    }

    const diffStats = this.diffCache?.getStats() ?? new Map();
    const filterLabel = this.mindMapFilter !== 'all' ? ` {yellow-fg}[f: ${this.mindMapFilter}]{/yellow-fg}` : ' {grey-fg}[f: all]{/grey-fg}';
    const viewLabel = `{grey-fg}[v: ${this.mindMapView}]{/grey-fg}${filterLabel}`;

    if (this.mindMapView === 'boxed') {
      return viewLabel + '\n' + renderMindMapBoxed(metrics, staticData, { blessedTags: true, center: false, filter: this.mindMapFilter !== 'all' ? this.mindMapFilter : undefined }).join('\n');
    }

    if (this.mindMapView === 'flow') {
      return viewLabel + '\n' + this.renderTimeFlow(metrics);
    }

    const tree = buildMindMapTree(metrics, staticData, diffStats, this.mindMapFilter !== 'all' ? this.mindMapFilter : undefined);
    return viewLabel + '\n' + renderTreeToText(tree, 0).join('\n');
  }

  /** Time-ordered flow view: recent events grouped by minute. */
  private renderTimeFlow(metrics: DashboardMetrics): string {
    const events = metrics.timeline.slice(-60);
    if (events.length === 0) return '{grey-fg}(no events yet){/grey-fg}';

    const lines: string[] = ['{bold}Time Flow{/bold}', ''];

    // Group events by minute
    const groups = new Map<string, typeof events>();
    for (const ev of events) {
      const time = formatTime(ev.timestamp);
      const minute = time.substring(0, 5); // HH:MM
      if (!groups.has(minute)) groups.set(minute, []);
      groups.get(minute)!.push(ev);
    }

    for (const [minute, evts] of groups) {
      lines.push(`{bold}{cyan-fg}── ${minute} ──{/cyan-fg}{/bold}`);
      for (const ev of evts) {
        const sec = formatTime(ev.timestamp).substring(6, 8);
        const color = EVENT_COLORS[ev.type] || 'white';
        const toolAnnotation = ev.toolName ? ` [${ev.toolName}]` : '';
        // Prefix visible width: "  :SS type       [toolName] "
        const prefixLen = 2 + 1 + 2 + 1 + 10 + toolAnnotation.length + 1;
        const summaryMax = Math.max(10, detailWidth() - prefixLen);
        const summary = truncate(ev.summary || '', summaryMax);
        const toolTag = ev.toolName ? ` {green-fg}[${ev.toolName}]{/green-fg}` : '';
        lines.push(`  {grey-fg}:${sec}{/grey-fg} {${color}-fg}${ev.type.padEnd(10)}{/${color}-fg}${toolTag} ${summary}`);
      }
    }

    return lines.join('\n');
  }

  private renderTools(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string; session?: SessionRecord };
    if (d.type === 'active') {
      const tools = metrics.toolStats.slice().sort((a, b) => b.calls - a.calls);
      if (tools.length === 0) return '{grey-fg}(no tools used){/grey-fg}';
      return tools.map(t => {
        const pending = t.pending > 0 ? `  {yellow-fg}(${t.pending} pending){/yellow-fg}` : '';
        return `{cyan-fg}${t.name.padEnd(18)}{/cyan-fg} ${String(t.calls).padStart(5)} calls${pending}`;
      }).join('\n');
    }

    // Historical
    const s = d.session!;
    if (s.toolUsage.length === 0) return '{grey-fg}(no tool data){/grey-fg}';
    return s.toolUsage.sort((a, b) => b.calls - a.calls).map(t =>
      `{cyan-fg}${t.tool.padEnd(18)}{/cyan-fg} ${String(t.calls).padStart(5)} calls`
    ).join('\n');
  }

  private renderFiles(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string };
    if (d.type !== 'active') {
      return '{grey-fg}(file data only available for active session){/grey-fg}';
    }

    const files = metrics.fileTouches.slice()
      .sort((a, b) => (b.reads + b.writes + b.edits) - (a.reads + a.writes + a.edits));
    if (files.length === 0) return '{grey-fg}(no file touches){/grey-fg}';

    const diffStats = this.diffCache?.getStats() ?? new Map();

    // Build header summary if there are any diff stats
    const lines: string[] = [];
    if (diffStats.size > 0) {
      let totalAdd = 0, totalDel = 0;
      for (const s of diffStats.values()) {
        totalAdd += s.additions;
        totalDel += s.deletions;
      }
      lines.push(
        `{bold}${diffStats.size} files changed{/bold}, {green-fg}+${totalAdd}{/green-fg} {red-fg}-${totalDel}{/red-fg}`,
        '',
      );
    }

    // Stats columns: " R:nn W:nn E:nn  +nn -nn" ≈ 30 chars
    const pathColWidth = Math.max(20, detailWidth() - 30);
    for (const f of files.slice(0, 40)) {
      const short = shortenPath(f.path);
      const r = f.reads > 0 ? `{green-fg}R:${f.reads}{/green-fg}` : `{grey-fg}R:0{/grey-fg}`;
      const wr = f.writes > 0 ? `{yellow-fg}W:${f.writes}{/yellow-fg}` : `{grey-fg}W:0{/grey-fg}`;
      const e = f.edits > 0 ? `{red-fg}E:${f.edits}{/red-fg}` : `{grey-fg}E:0{/grey-fg}`;

      // Look up diff stats by repo-relative path
      const relPath = this.diffCache?.toRelative(f.path) ?? f.path;
      const ds = diffStats.get(relPath);
      const diffSuffix = ds
        ? `  {green-fg}+${ds.additions}{/green-fg} {red-fg}-${ds.deletions}{/red-fg}`
        : '';

      lines.push(`{cyan-fg}${short.padEnd(pathColWidth)}{/cyan-fg} ${r} ${wr} ${e}${diffSuffix}`);
    }

    return lines.join('\n');
  }
  private renderAgents(item: PanelItem, metrics: DashboardMetrics): string {
    const d = item.data as { type: string };
    if (d.type !== 'active') {
      return '{grey-fg}(agent data only available for active session){/grey-fg}';
    }

    const agents = metrics.subagents;
    if (agents.length === 0) return '{grey-fg}(no subagents spawned){/grey-fg}';

    const running = agents.filter(a => a.status === 'running').length;
    const completed = agents.filter(a => a.status === 'completed').length;
    const parallel = agents.filter(a => a.isParallel).length;

    const lines: string[] = [
      '{bold}Subagents{/bold}',
      '',
      `  Total: ${agents.length}  Running: {green-fg}${running}{/green-fg}  Completed: {cyan-fg}${completed}{/cyan-fg}` +
        (parallel > 0 ? `  Parallel: {magenta-fg}${parallel}{/magenta-fg}` : ''),
      '',
    ];

    for (const a of agents) {
      const icon = a.status === 'running'
        ? '{green-fg}\u21BB{/green-fg}'   // ↻
        : a.isParallel
          ? '{magenta-fg}\u229A{/magenta-fg}' // ⊚
          : '{cyan-fg}\u2713{/cyan-fg}';      // ✓

      const duration = a.durationMs !== undefined ? formatDuration(a.durationMs) : '';
      const durationSuffix = duration ? `  {grey-fg}${duration}{/grey-fg}` : '';
      const parallelFlag = a.isParallel && a.status === 'completed' ? ' {magenta-fg}(parallel){/magenta-fg}' : '';

      // Compute available width for description, accounting for suffix on first line
      const prefixVisible = 2 + visibleLength(a.subagentType) + 1; // "icon type "
      const suffixVisible = visibleLength(durationSuffix) + visibleLength(parallelFlag);
      const descWidth = Math.max(20, detailWidth() - prefixVisible - suffixVisible);
      const indent = ' '.repeat(prefixVisible);
      const wrapped = wordWrap(a.description, descWidth, indent);
      const firstLine = wrapped.split('\n')[0];
      const restLines = wrapped.split('\n').slice(1);
      lines.push(
        `${icon} {magenta-fg}${a.subagentType}{/magenta-fg} ${firstLine}${durationSuffix}${parallelFlag}`
      );
      for (const rl of restLines) lines.push(rl);
    }

    // Cross-reference: tasks created by subagents
    const subagentTasks = metrics.tasks.filter(t => t.subagentType);
    if (subagentTasks.length > 0) {
      lines.push('', '{bold}Tasks from Subagents{/bold}', '');
      for (const t of subagentTasks) {
        const statusIcon = t.status === 'completed' ? '\u2713' : t.status === 'in_progress' ? '\u2192' : '\u25CB';
        const taskPrefix = `  ${statusIcon} ${t.subagentType} #${t.taskId}: `;
        const taskIndent = ' '.repeat(taskPrefix.length);
        lines.push(`  ${statusIcon} {magenta-fg}${t.subagentType}{/magenta-fg} #${t.taskId}: ${wordWrap(t.subject, detailWidth() - taskPrefix.length, taskIndent)}`);
      }
    }

    return lines.join('\n');
  }
}

// ── Helpers ──

const EVENT_COLORS: Record<string, string> = {
  user: 'cyan', assistant: 'green', tool_use: 'yellow',
  tool_result: 'grey', summary: 'magenta', system: 'grey',
};

function renderContextAttribution(attr: ContextAttribution): string[] {
  const categories: Array<{ label: string; tokens: number; color: string; char: string }> = [
    { label: 'System Prompt', tokens: attr.systemPrompt, color: 'magenta', char: '\u2588' },
    { label: 'User Messages', tokens: attr.userMessages, color: 'cyan', char: '\u2588' },
    { label: 'Assistant', tokens: attr.assistantResponses, color: 'green', char: '\u2588' },
    { label: 'Tool Inputs', tokens: attr.toolInputs, color: 'yellow', char: '\u2588' },
    { label: 'Tool Outputs', tokens: attr.toolOutputs, color: 'grey', char: '\u2588' },
    { label: 'Thinking', tokens: attr.thinking, color: 'blue', char: '\u2588' },
    { label: 'Other', tokens: attr.other, color: 'white', char: '\u2588' },
  ];

  const total = categories.reduce((sum, c) => sum + c.tokens, 0);
  if (total === 0) return [];

  const barWidth = 30;
  const lines: string[] = ['{bold}Context Attribution{/bold}', ''];

  // Stacked bar
  let bar = '  ';
  for (const cat of categories) {
    if (cat.tokens === 0) continue;
    const width = Math.max(1, Math.round((cat.tokens / total) * barWidth));
    bar += `{${cat.color}-fg}${cat.char.repeat(width)}{/${cat.color}-fg}`;
  }
  lines.push(bar);
  lines.push('');

  // Legend with token counts and percentages
  for (const cat of categories) {
    if (cat.tokens === 0) continue;
    const pct = ((cat.tokens / total) * 100).toFixed(0);
    lines.push(
      `  {${cat.color}-fg}${cat.char}{/${cat.color}-fg} ${cat.label.padEnd(16)} ${fmtNum(cat.tokens).padStart(7)}  ${pct.padStart(3)}%`
    );
  }

  return lines;
}
