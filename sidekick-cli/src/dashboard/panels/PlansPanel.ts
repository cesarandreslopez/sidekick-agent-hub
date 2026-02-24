/**
 * Plans panel — displays active and historical plans from agent sessions.
 * Shows plan steps, metrics, and raw markdown across three detail tabs.
 */

import { execSync } from 'child_process';
import type { SidePanel, PanelItem, PanelAction, DetailTab } from './types';
import type { DashboardMetrics, PlanInfo } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { PersistedPlan, PlanSource } from 'sidekick-shared';
import { wordWrap, detailWidth, makeBar, fmtNum, formatDuration, truncate } from '../formatters';

const STATUS_ICONS: Record<string, string> = {
  completed: '{green-fg}\u2713{/green-fg}',
  in_progress: '{yellow-fg}\u2192{/yellow-fg}',
  failed: '{red-fg}\u2717{/red-fg}',
  abandoned: '{grey-fg}\u2014{/grey-fg}',
};

const STEP_ICONS: Record<string, string> = {
  completed: '{green-fg}\u2713{/green-fg}',
  in_progress: '{yellow-fg}\u25B6{/yellow-fg}',
  pending: '{grey-fg}\u25CB{/grey-fg}',
  failed: '{red-fg}\u2717{/red-fg}',
  skipped: '{grey-fg}\u2014{/grey-fg}',
};

const SOURCE_BADGES: Record<string, string> = {
  'claude-code': '{cyan-fg}CC{/cyan-fg}',
  'opencode': '{magenta-fg}OC{/magenta-fg}',
  'codex': '{blue-fg}CX{/blue-fg}',
};

const COMPLEXITY_BADGES: Record<string, string> = {
  high: '{red-fg}H{/red-fg}',
  medium: '{yellow-fg}M{/yellow-fg}',
  low: '{green-fg}L{/green-fg}',
};

const SOURCE_CYCLE: (PlanSource | 'all')[] = ['all', 'claude-code', 'opencode', 'codex'];

export class PlansPanel implements SidePanel {
  readonly id = 'plans';
  readonly title = 'Plans';
  readonly shortcutKey = 6;

  private sourceFilter: PlanSource | 'all' = 'all';

  readonly detailTabs: DetailTab[] = [
    { label: 'Steps', render: (item) => this.renderSteps(item) },
    { label: 'Metrics', render: (item) => this.renderMetrics(item) },
    { label: 'Raw', render: (item) => this.renderRaw(item) },
  ];

  getItems(metrics: DashboardMetrics, staticData: StaticData): PanelItem[] {
    const items: PanelItem[] = [];
    const activeSessionPlanAdded = new Set<string>();

    // Active plan from live metrics (pinned at top)
    if (metrics.plan) {
      const plan = metrics.plan;
      const rate = plan.completionRate != null ? Math.round(plan.completionRate * 100) : 0;
      const source = plan.source || 'claude-code';
      const badge = SOURCE_BADGES[source] || source;
      const icon = STATUS_ICONS['in_progress'];
      const title = truncate(plan.title, 30);
      const label = `${icon} ${title}  ${badge}  ${rate}%`;

      if (this.sourceFilter === 'all' || this.sourceFilter === source) {
        items.push({
          id: 'active-plan',
          label,
          sortKey: -1, // pin at top
          data: { type: 'active' as const, plan },
        });
      }

      // Track session to avoid duplicating in history
      if (metrics.sessionStartTime) {
        activeSessionPlanAdded.add(metrics.sessionStartTime.substring(0, 8));
      }
    }

    // Historical plans from static data
    const plans = staticData.plans || [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];

      // Skip if this is the active session's plan
      if (activeSessionPlanAdded.has(p.sessionId.substring(0, 8))) continue;

      // Apply source filter
      if (this.sourceFilter !== 'all' && p.source !== this.sourceFilter) continue;

      const rate = Math.round(p.completionRate * 100);
      const icon = STATUS_ICONS[p.status] || STATUS_ICONS['in_progress'];
      const badge = SOURCE_BADGES[p.source] || p.source;
      const title = truncate(p.title, 30);
      const date = p.createdAt.substring(0, 10);
      const label = `${icon} ${title}  ${badge}  ${rate}%  ${date}`;

      items.push({
        id: `plan-${i}`,
        label,
        sortKey: i,
        data: { type: 'historical' as const, plan: p },
      });
    }

    return items;
  }

  getActions(): PanelAction[] {
    return [
      {
        key: 'c',
        label: 'Copy markdown',
        handler: (item) => this.copyMarkdown(item),
      },
      {
        key: 's',
        label: `Source: ${this.sourceFilter}`,
        handler: () => this.cycleSource(),
      },
    ];
  }

  getSearchableText(item: PanelItem): string {
    const d = item.data as { type: string; plan: PlanInfo | PersistedPlan };
    const plan = d.plan;
    const parts = [plan.title, plan.source || ''];

    if ('steps' in plan) {
      for (const s of plan.steps) {
        parts.push(s.description);
      }
    }

    if ('prompt' in plan && plan.prompt) {
      parts.push(plan.prompt);
    }

    return parts.join(' ');
  }

  // ── Detail renderers ──

  private renderSteps(item: PanelItem): string {
    const d = item.data as { type: string; plan: PlanInfo | PersistedPlan };
    const plan = d.plan;
    const w = detailWidth();
    const lines: string[] = [];

    lines.push(`{bold}${wordWrap(plan.title, w)}{/bold}`);
    lines.push('');

    const steps: Array<{ id: string; description: string; status?: string; phase?: string; complexity?: string }> = plan.steps;
    if (steps.length === 0) {
      lines.push('{grey-fg}(no steps){/grey-fg}');
      return lines.join('\n');
    }

    // Completion progress bar
    const completed = steps.filter(s => s.status === 'completed').length;
    const rate = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;
    const barWidth = Math.min(30, w - 20);
    lines.push(`{bold}Progress:{/bold} ${makeBar(rate, barWidth)} ${rate}% (${completed}/${steps.length})`);
    lines.push('');

    // Group by phase if phases exist
    const phased = steps.some(s => s.phase);
    if (phased) {
      const groups = new Map<string, typeof steps>();
      for (const s of steps) {
        const phase = s.phase || 'Unphased';
        if (!groups.has(phase)) groups.set(phase, []);
        groups.get(phase)!.push(s);
      }
      for (const [phase, phaseSteps] of groups) {
        lines.push(`{bold}{underline}${phase}{/underline}{/bold}`);
        for (const s of phaseSteps) {
          lines.push(this.formatStep(s, w));
        }
        lines.push('');
      }
    } else {
      for (const s of steps) {
        lines.push(this.formatStep(s, w));
      }
    }

    return lines.join('\n');
  }

  private formatStep(s: { description: string; status?: string; complexity?: string }, w: number): string {
    const icon = STEP_ICONS[s.status || 'pending'] || STEP_ICONS['pending'];
    const complexity = s.complexity ? ` ${COMPLEXITY_BADGES[s.complexity] || ''}` : '';
    return `  ${icon}${complexity} ${wordWrap(s.description, w - 6)}`;
  }

  private renderMetrics(item: PanelItem): string {
    const d = item.data as { type: string; plan: PlanInfo | PersistedPlan };
    const plan = d.plan;
    const w = detailWidth();
    const lines: string[] = [];

    lines.push(`{bold}${wordWrap(plan.title, w)}{/bold}`);
    lines.push('');

    if (d.type === 'active') {
      const activePlan = plan as PlanInfo;
      const steps = activePlan.steps;
      const completed = steps.filter(s => s.status === 'completed').length;
      const inProgress = steps.filter(s => s.status === 'in_progress').length;
      const failed = steps.filter(s => s.status === 'failed').length;
      const pending = steps.filter(s => s.status === 'pending').length;

      lines.push('{bold}Steps Breakdown{/bold}');
      lines.push(`  Completed:   ${completed}`);
      lines.push(`  In Progress: ${inProgress}`);
      lines.push(`  Pending:     ${pending}`);
      if (failed > 0) lines.push(`  Failed:      ${failed}`);
      lines.push('');

      if (activePlan.totalDurationMs) {
        lines.push(`{bold}Duration:{/bold} ${formatDuration(activePlan.totalDurationMs)}`);
      }

      lines.push('');
      lines.push('{grey-fg}(metrics finalize after completion){/grey-fg}');
    } else {
      const hist = plan as PersistedPlan;
      const steps = hist.steps;
      const completed = steps.filter(s => s.status === 'completed').length;
      const inProgress = steps.filter(s => s.status === 'in_progress').length;
      const failed = steps.filter(s => s.status === 'failed').length;
      const pending = steps.filter(s => s.status === 'pending').length;
      const skipped = steps.filter(s => s.status === 'skipped').length;

      if (hist.totalDurationMs) {
        lines.push(`{bold}Duration:{/bold}    ${formatDuration(hist.totalDurationMs)}`);
      }
      if (hist.totalTokensUsed) {
        lines.push(`{bold}Tokens:{/bold}      ${fmtNum(hist.totalTokensUsed)}`);
      }
      if (hist.totalCostUsd) {
        lines.push(`{bold}Cost:{/bold}        $${hist.totalCostUsd.toFixed(4)}`);
      }
      if (hist.totalToolCalls) {
        lines.push(`{bold}Tool Calls:{/bold}  ${hist.totalToolCalls}`);
      }
      lines.push('');

      lines.push('{bold}Steps Breakdown{/bold}');
      lines.push(`  Completed:   ${completed}`);
      if (inProgress > 0) lines.push(`  In Progress: ${inProgress}`);
      lines.push(`  Pending:     ${pending}`);
      if (failed > 0) lines.push(`  Failed:      ${failed}`);
      if (skipped > 0) lines.push(`  Skipped:     ${skipped}`);
      lines.push('');

      lines.push(`{bold}Source:{/bold}      ${hist.source}`);
      lines.push(`{bold}Status:{/bold}      ${hist.status}`);
      lines.push(`{bold}Created:{/bold}     ${hist.createdAt}`);
      if (hist.completedAt) {
        lines.push(`{bold}Completed:{/bold}   ${hist.completedAt}`);
      }
    }

    return lines.join('\n');
  }

  private renderRaw(item: PanelItem): string {
    const d = item.data as { type: string; plan: PlanInfo | PersistedPlan };
    const plan = d.plan;
    const w = detailWidth();

    const raw = plan.rawMarkdown;
    if (!raw) {
      return '{grey-fg}(no raw markdown available){/grey-fg}';
    }

    return wordWrap(raw, w);
  }

  // ── Actions ──

  private copyMarkdown(item: PanelItem): void {
    const d = item.data as { type: string; plan: PlanInfo | PersistedPlan };
    const raw = d.plan.rawMarkdown;
    if (!raw) return;

    try {
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: raw });
      } else {
        execSync('xclip -selection clipboard', { input: raw });
      }
    } catch {
      // Clipboard not available
    }
  }

  private cycleSource(): void {
    const idx = SOURCE_CYCLE.indexOf(this.sourceFilter);
    this.sourceFilter = SOURCE_CYCLE[(idx + 1) % SOURCE_CYCLE.length];
  }
}
