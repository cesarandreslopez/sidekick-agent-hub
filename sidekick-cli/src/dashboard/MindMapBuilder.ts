/**
 * Transforms DashboardMetrics + StaticData into a blessed-contrib TreeData
 * structure for the MindMap page, and into colored ANSI text for the standalone
 * `sidekick mindmap` command.
 *
 * Mirrors the VS Code MindMapDataService hub-and-spoke graph, but outputs a
 * hierarchical tree with color-coded labels, status icons, and cross-link
 * annotations — since a force-directed graph can't render in a terminal.
 */

import type { DashboardMetrics, TaskItem, FileTouch } from './DashboardState';
import type { DiffStat } from './GitDiffCache';

/** Tree structure for mind map rendering (previously from blessed-contrib). */
export interface TreeData {
  extended?: boolean;
  children?: Record<string, TreeData>;
  name?: string;
}
import type { StaticData } from './StaticDataLoader';
import { shortenPath, formatDuration, truncate } from './formatters';

// ── Color mapping (VS Code palette → blessed tag names) ──

const COLORS = {
  session:        'grey',
  file:           'blue',
  tool:           'green',
  todo:           'yellow',
  subagent:       'magenta',
  url:            'cyan',
  directory:      'yellow',
  command:        'red',
  task:           'red',
  plan:           'cyan',
  'plan-step':    'cyan',
  'knowledge-note': 'yellow',
} as const;

// ── ANSI escape codes (for standalone renderer) ──

const ANSI: Record<string, string> = {
  grey:    '\x1b[90m',
  blue:    '\x1b[34m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
};

// ── Status icons ──

const STATUS_ICON: Record<string, string> = {
  completed:   '\u2713', // ✓
  in_progress: '\u2192', // →
  pending:     '\u25CB', // ○
};

/** ASCII-safe status icons for boxed renderer (avoids double-width Unicode). */
const BOX_STATUS_ICON: Record<string, string> = {
  completed:   'v',
  in_progress: '>',
  pending:     'o',
};

// ── Public API ──

/**
 * Build a blessed-contrib TreeData structure for the MindMap page.
 * Labels use blessed `{color-fg}...{/color-fg}` tags for color.
 */
export function buildMindMapTree(metrics: DashboardMetrics, staticData: StaticData, diffStats?: Map<string, DiffStat>): TreeData {
  const sessionId = (metrics.sessionStartTime || 'unknown').substring(0, 8);
  const rootLabel = tag('session', `SESSION [${sessionId}] \u2014 claude-code`);

  const children: Record<string, TreeData> = {};

  // ── Tools section (with files, URLs, dirs, commands nested under their tool) ──
  addToolsSection(children, metrics, diffStats);

  // ── Tasks section ──
  addTasksSection(children, metrics);

  // ── Plan section ──
  addPlanSection(children, metrics);

  // ── Subagents section ──
  addSubagentsSection(children, metrics);

  // ── TODOs section ──
  addTodosSection(children, metrics);

  // ── Knowledge Notes section ──
  addKnowledgeNotesSection(children, staticData);

  return {
    extended: true,
    children: {
      [rootLabel]: {
        extended: true,
        children,
      },
    },
  };
}

/**
 * Render the mind map as colored ANSI text for stdout.
 * Returns an array of lines (no trailing newline).
 */
export function renderMindMapAnsi(metrics: DashboardMetrics, staticData: StaticData): string[] {
  const tree = buildMindMapTree(metrics, staticData);
  const lines: string[] = [];
  renderTreeAnsi(tree, lines, '', true);
  return lines;
}

// ── Section builders ──

function addToolsSection(children: Record<string, TreeData>, metrics: DashboardMetrics, diffStats?: Map<string, DiffStat>): void {
  if (metrics.toolStats.length === 0) return;

  const totalCalls = metrics.toolStats.reduce((s, t) => s + t.calls, 0);
  const fileSuffix = metrics.fileTouches.length > 0
    ? ` \u2192 ${metrics.fileTouches.length} files`
    : '';
  const label = tag('tool', `Tools (${metrics.toolStats.length} types, ${totalCalls} calls${fileSuffix})`);
  const toolChildren: Record<string, TreeData> = {};

  // Group files by tool
  const filesByTool = groupFilesByTool(metrics);
  // Group URLs by tool
  const urlsByTool = groupUrlsByTool(metrics);
  // Group dirs by tool
  const dirsByTool = groupDirsByTool(metrics);

  for (const t of metrics.toolStats) {
    const pending = t.pending > 0 ? ` (${t.pending} pending)` : '';
    const toolLabel = tag('tool', `${t.name}`) + ` \u00B7\u00B7\u00B7 ${t.calls} calls${pending}`;
    const toolLeaves: Record<string, TreeData> = {};

    // Nested files
    const files = filesByTool.get(t.name);
    if (files) {
      for (const f of files) {
        const total = f.reads + f.writes + f.edits;
        const parts: string[] = [];
        if (f.reads > 0) parts.push(`${f.reads}R`);
        if (f.writes > 0) parts.push(`${f.writes}W`);
        if (f.edits > 0) parts.push(`${f.edits}E`);
        // Append diff stats if available
        const shortPath = shortenPath(f.path);
        const ds = diffStats?.get(f.path) ?? diffStats?.get(shortPath);
        const diffSuffix = ds ? ` {green-fg}+${ds.additions}{/green-fg} {red-fg}-${ds.deletions}{/red-fg}` : '';
        toolLeaves[tag('file', shortPath) + ` (${total}\u00D7, ${parts.join('/')})${diffSuffix}`] = {};
      }
    }

    // Nested URLs
    const urls = urlsByTool.get(t.name);
    if (urls) {
      for (const u of urls) {
        toolLeaves[tag('url', getUrlLabel(u.url)) + ` (${u.count}\u00D7)`] = {};
      }
    }

    // Nested directories
    const dirs = dirsByTool.get(t.name);
    if (dirs) {
      for (const d of dirs) {
        const patternSuffix = d.patterns.length > 0
          ? `, patterns: ${d.patterns.slice(0, 3).map(p => `"${truncate(p, 20)}"`).join(', ')}`
          : '';
        toolLeaves[tag('directory', shortenPath(d.path)) + ` (${d.count}\u00D7${patternSuffix})`] = {};
      }
    }

    // Nested commands (only under Bash)
    if (t.name === 'Bash') {
      for (const cmd of metrics.commands) {
        toolLeaves[tag('command', cmd.name) + ` (${cmd.count}\u00D7)`] = {};
      }
    }

    toolChildren[toolLabel] = Object.keys(toolLeaves).length > 0
      ? { extended: false, children: toolLeaves }
      : {};
  }

  children[label] = { extended: true, children: toolChildren };
}

function addTasksSection(children: Record<string, TreeData>, metrics: DashboardMetrics): void {
  if (metrics.tasks.length === 0) return;

  const crossLinks = metrics.tasks.reduce((sum, t) => sum + t.blocks.length + t.blockedBy.length, 0);
  const crossSuffix = crossLinks > 0 ? `, ${crossLinks} cross-links` : '';
  const label = tag('task', `Tasks (${metrics.tasks.length}${crossSuffix})`);
  const taskChildren: Record<string, TreeData> = {};

  for (const t of metrics.tasks) {
    const icon = STATUS_ICON[t.status] || '\u25CB';
    const suffix = t.toolCallCount > 0 ? ` (${t.toolCallCount} tool calls)` : '';
    const crossLinks = buildTaskCrossLinks(t, metrics.tasks);
    taskChildren[`${icon} ${tag('task', t.subject)}${suffix}${crossLinks}`] = {};
  }

  children[label] = { extended: true, children: taskChildren };
}

function addPlanSection(children: Record<string, TreeData>, metrics: DashboardMetrics): void {
  if (!metrics.plan) return;

  const label = tag('plan', `Plan: "${metrics.plan.title}" (${metrics.plan.steps.length} steps)`);
  const stepChildren: Record<string, TreeData> = {};

  for (let i = 0; i < metrics.plan.steps.length; i++) {
    const step = metrics.plan.steps[i];
    const icon = STATUS_ICON[step.status] || '\u25CB';
    const phaseLabel = step.phase ? `[${step.phase}] ` : '';
    // Try to cross-reference to a matching task
    const taskXref = findMatchingTask(step.description, metrics.tasks);
    const xrefSuffix = taskXref ? ` \u2192 Task #${taskXref.taskId}` : '';
    stepChildren[`[${icon}] ${tag('plan-step', `${phaseLabel}${truncate(step.description, 50)}`)}${xrefSuffix}`] = {};
  }

  children[label] = { extended: true, children: stepChildren };
}

function addSubagentsSection(children: Record<string, TreeData>, metrics: DashboardMetrics): void {
  if (metrics.subagents.length === 0) return;

  const running = metrics.subagents.filter(a => a.status === 'running').length;
  const countSuffix = running > 0 ? `, ${running} running` : '';
  const label = tag('subagent', `Subagents (${metrics.subagents.length}${countSuffix})`);
  const subChildren: Record<string, TreeData> = {};

  for (const s of metrics.subagents) {
    const icon = s.status === 'running' ? '\u21BB' : s.isParallel ? '\u229A' : '\u2713';
    const duration = s.durationMs !== undefined ? ` [${formatDuration(s.durationMs)}]` : '';
    subChildren[`${icon} ${tag('subagent', `${s.subagentType}: "${truncate(s.description, 40)}"`)}${duration}`] = {};
  }

  children[label] = { extended: true, children: subChildren };
}

function addTodosSection(children: Record<string, TreeData>, metrics: DashboardMetrics): void {
  if (metrics.todos.length === 0) return;

  const label = tag('todo', `TODOs (${metrics.todos.length})`);
  const todoChildren: Record<string, TreeData> = {};

  for (const todo of metrics.todos) {
    todoChildren[tag('todo', truncate(todo, 60))] = {};
  }

  children[label] = { extended: true, children: todoChildren };
}

function addKnowledgeNotesSection(children: Record<string, TreeData>, staticData: StaticData): void {
  if (staticData.notes.length === 0) return;

  const label = tag('knowledge-note', `Knowledge Notes (${staticData.notes.length})`);
  const noteChildren: Record<string, TreeData> = {};

  // Group by file
  const byFile = new Map<string, Array<{ type: string; content: string }>>();
  for (const n of staticData.notes) {
    const file = shortenPath(n.filePath);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ type: n.noteType, content: n.content });
  }

  for (const [file, notes] of byFile) {
    const noteItems: Record<string, TreeData> = {};
    for (const n of notes.slice(0, 5)) {
      const icon = n.type === 'gotcha' ? '[!]' : n.type === 'pattern' ? '[~]' : '[#]';
      noteItems[tag('knowledge-note', `${icon} ${truncate(n.content, 50)}`)] = {};
    }
    noteChildren[tag('file', file)] = { extended: false, children: noteItems };
  }

  children[label] = { extended: false, children: noteChildren };
}

// ── Grouping helpers ──

function groupFilesByTool(metrics: DashboardMetrics): Map<string, FileTouch[]> {
  const result = new Map<string, FileTouch[]>();
  for (const f of metrics.fileTouches) {
    // Files link to Read/Write/Edit based on which counts are nonzero
    if (f.reads > 0) addToGroup(result, 'Read', f);
    if (f.writes > 0) addToGroup(result, 'Write', f);
    if (f.edits > 0) addToGroup(result, 'Edit', f);
  }
  return result;
}

function groupUrlsByTool(metrics: DashboardMetrics): Map<string, Array<{ url: string; count: number }>> {
  // URLs come from WebFetch/WebSearch — we can't tell which tool produced which URL
  // from the aggregated data, so we group them under whichever URL tools are in toolStats
  const result = new Map<string, Array<{ url: string; count: number }>>();
  const urlTools = metrics.toolStats.filter(t => ['WebFetch', 'WebSearch'].includes(t.name));
  if (urlTools.length > 0 && metrics.urls.length > 0) {
    // Place all URLs under the first matching tool
    result.set(urlTools[0].name, metrics.urls);
  }
  return result;
}

function groupDirsByTool(metrics: DashboardMetrics): Map<string, Array<{ path: string; count: number; patterns: string[] }>> {
  const result = new Map<string, Array<{ path: string; count: number; patterns: string[] }>>();
  const searchTools = metrics.toolStats.filter(t => ['Grep', 'Glob'].includes(t.name));
  if (searchTools.length > 0 && metrics.directories.length > 0) {
    result.set(searchTools[0].name, metrics.directories);
  }
  return result;
}

function addToGroup<T>(map: Map<string, T[]>, key: string, value: T): void {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(value);
}

// ── Cross-link helpers ──

function buildTaskCrossLinks(task: TaskItem, _allTasks: TaskItem[]): string {
  const parts: string[] = [];
  if (task.blocks.length > 0) {
    parts.push(`blocks: #${task.blocks.join(', #')}`);
  }
  if (task.blockedBy.length > 0) {
    parts.push(`blocked by: #${task.blockedBy.join(', #')}`);
  }
  return parts.length > 0 ? ` [${parts.join('; ')}]` : '';
}

function findMatchingTask(description: string, tasks: TaskItem[]): TaskItem | undefined {
  const descLower = description.toLowerCase();
  return tasks.find(t => {
    const subjectLower = t.subject.toLowerCase();
    return descLower.includes(subjectLower) || subjectLower.includes(descLower);
  });
}

// ── Label helpers ──

/** Wrap text in blessed color tags. */
function tag(nodeType: keyof typeof COLORS, text: string): string {
  const color = COLORS[nodeType];
  return `{${color}-fg}${text}{/${color}-fg}`;
}

function getUrlLabel(urlOrQuery: string): string {
  try {
    const url = new URL(urlOrQuery);
    return url.hostname;
  } catch {
    return truncate(urlOrQuery, 25);
  }
}

// ── ANSI tree renderer (for standalone `sidekick mindmap` command) ──

/**
 * Recursively render a TreeData structure as colored ANSI lines.
 * Strips blessed `{color-fg}...{/color-fg}` tags and replaces them with ANSI codes.
 */
function renderTreeAnsi(node: TreeData, lines: string[], prefix: string, isRoot: boolean): void {
  const childEntries = Object.entries(node.children || {});

  if (isRoot && childEntries.length > 0) {
    // Root level — render each top-level key
    for (let i = 0; i < childEntries.length; i++) {
      const [label, child] = childEntries[i];
      lines.push(blessedToAnsi(label));
      const childKeys = Object.entries(child.children || {});
      for (let j = 0; j < childKeys.length; j++) {
        const [childLabel, grandChild] = childKeys[j];
        const isLast = j === childKeys.length - 1;
        const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
        const nextPrefix = isLast ? '    ' : '\u2502   ';
        lines.push(prefix + connector + blessedToAnsi(childLabel));
        renderTreeAnsi(grandChild, lines, prefix + nextPrefix, false);
      }
    }
  } else {
    const entries = Object.entries(node.children || {});
    for (let i = 0; i < entries.length; i++) {
      const [label, child] = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
      const nextPrefix = isLast ? '    ' : '\u2502   ';
      lines.push(prefix + connector + blessedToAnsi(label));
      renderTreeAnsi(child, lines, prefix + nextPrefix, false);
    }
  }
}

/** Convert blessed `{color-fg}text{/color-fg}` tags to ANSI escape codes. */
function blessedToAnsi(text: string): string {
  return text.replace(/\{(\w+)-fg\}(.*?)\{\/\1-fg\}/g, (_match, color: string, content: string) => {
    const ansi = ANSI[color] || '';
    return ansi + content + ANSI.reset;
  });
}

// ── Tree-to-text renderer (for blessed TUI) ──

/** Cycle of colors for depth-based tree connector coloring. */
const DEPTH_COLORS = ['cyan', 'yellow', 'green', 'magenta', 'blue', 'red'];

/**
 * Render a blessed-contrib TreeData node as indented text lines
 * using blessed `{color-fg}` tags. Used by the Mind Map detail tab.
 */
export function renderTreeToText(node: TreeData, depth: number, columns?: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const termCols = columns ?? (process.stdout?.columns || 80);

  if (node.children) {
    const entries = Object.entries(node.children);
    for (let i = 0; i < entries.length; i++) {
      const [label, child] = entries[i];
      const isLast = i === entries.length - 1;
      if (depth === 0) {
        lines.push(label);
      } else {
        const color = DEPTH_COLORS[(depth - 1) % DEPTH_COLORS.length];
        const connector = isLast ? '\u2514\u2500 ' : '\u251C\u2500 ';
        const coloredConnector = `{${color}-fg}${connector}{/${color}-fg}`;
        // Truncate label to fit available width
        const availableWidth = termCols - (depth * 2) - 4;
        const plainLabel = label.replace(/\{[^}]*\}/g, '');
        const truncLabel = plainLabel.length > availableWidth && availableWidth > 10
          ? truncateTagged(label, availableWidth)
          : label;
        lines.push(`${indent}${coloredConnector}${truncLabel}`);
      }
      lines.push(...renderTreeToText(child, depth + 1, termCols));
    }
  }

  return lines;
}

/** Truncate a blessed-tagged string to fit within maxVisible characters. */
function truncateTagged(text: string, maxVisible: number): string {
  // Strip tags to measure visible length
  const plain = text.replace(/\{[^}]*\}/g, '');
  if (plain.length <= maxVisible) return text;
  // Naive truncation — cut the plain text and hope tags balance out
  // Build result char by char, tracking visible count
  let visible = 0;
  let result = '';
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { inTag = true; result += ch; continue; }
    if (inTag) { result += ch; if (ch === '}') inTag = false; continue; }
    if (visible >= maxVisible - 3) { result += '...'; break; }
    result += ch;
    visible++;
  }
  return result;
}

// ── Boxed renderer ──

interface BoxSection {
  icon: string;
  title: string;
  subtitle: string;
  color: string;
  lines: string[];
}

export interface BoxedRenderOptions {
  /** Use blessed `{color-fg}` tags instead of ANSI escape codes. */
  blessedTags?: boolean;
  /** Available content width (used for box width calculation). */
  columns?: number;
  /** Center boxes horizontally. Default: true. */
  center?: boolean;
}

/**
 * Compute the box width for the boxed renderer.
 * `min(terminalColumns - 8, 50)` with fallback 50.
 */
function getBoxWidth(columns?: number): number {
  const cols = columns ?? (
    typeof process !== 'undefined' && process.stdout?.columns
      ? process.stdout.columns
      : 80
  );
  return Math.min(cols - 8, 50);
}

/** Measure visible length, ignoring blessed tags and ANSI escape codes. */
function visibleLength(text: string): number {
  return text
    .replace(/\{[^}]+\}/g, '')       // blessed tags
    .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI escapes
    .length;
}

/** Pad or truncate `text` to exactly `width` visible chars. */
function fitText(text: string, width: number): string {
  const vLen = visibleLength(text);
  if (vLen <= width) return text + ' '.repeat(width - vLen);
  // Truncate plain text (no tags) by visible length
  return text.substring(0, width - 3) + '...';
}

/** Format a two-column line: left-aligned `left`, right-aligned `right`, total = `width`. */
function twoCols(left: string, right: string, width: number): string {
  const rLen = right.length;
  const lMax = width - rLen - 1; // at least 1 space gap
  const lTrunc = left.length > lMax ? left.substring(0, lMax - 3) + '...' : left;
  const gap = width - lTrunc.length - rLen;
  return lTrunc + ' '.repeat(Math.max(1, gap)) + right;
}

/** Render a double-line box (session header). */
function renderDoubleBox(lines: string[], boxW: number): string[] {
  const out: string[] = [];
  // ║ (1) + "  " (2) + content + "  " (2) + ║ (1) = content + 6
  const inner = boxW - 6;
  out.push(`╔${'═'.repeat(boxW - 2)}╗`);
  for (const line of lines) {
    out.push(`║  ${fitText(line, inner)}  ║`);
  }
  out.push(`╚${'═'.repeat(boxW - 2)}╝`);
  return out;
}

/** Render a single-line box (section). */
function renderSingleBox(header: string, bodyLines: string[], boxW: number): string[] {
  const out: string[] = [];
  // │ (1) + "  " (2) + content + "  " (2) + │ (1) = content + 6
  const inner = boxW - 6;
  out.push(`┌${'─'.repeat(boxW - 2)}┐`);
  out.push(`│  ${fitText(header, inner)}  │`);
  out.push(`├${'─'.repeat(boxW - 2)}┤`);
  for (const line of bodyLines) {
    out.push(`│  ${fitText(line, inner)}  │`);
  }
  out.push(`└${'─'.repeat(boxW - 2)}┘`);
  return out;
}

/** Render stem connector between boxes. */
function renderStem(boxW: number): string[] {
  const center = Math.floor(boxW / 2);
  return [' '.repeat(center) + '│'];
}

/** Center a box horizontally with a left margin. */
function indentBox(boxLines: string[], boxW: number, center: boolean, columns?: number): string[] {
  if (!center) return boxLines;
  const cols = columns ?? (
    typeof process !== 'undefined' && process.stdout?.columns
      ? process.stdout.columns
      : 80
  );
  const margin = Math.max(0, Math.floor((cols - boxW) / 2));
  const pad = ' '.repeat(margin);
  return boxLines.map(l => pad + l);
}

// ── Section content builders (for boxed renderer) ──

function buildToolsBoxSection(metrics: DashboardMetrics): BoxSection | null {
  if (metrics.toolStats.length === 0) return null;

  const totalCalls = metrics.toolStats.reduce((s, t) => s + t.calls, 0);
  const lines: string[] = [];
  const filesByTool = groupFilesByTool(metrics);

  for (const t of metrics.toolStats) {
    const dots = '·'.repeat(Math.max(1, 7 - t.name.length));
    lines.push(`${t.name} ${dots} ${t.calls}×`);

    // Nested files (abbreviated)
    const files = filesByTool.get(t.name);
    if (files) {
      for (const f of files.slice(0, 3)) {
        const total = f.reads + f.writes + f.edits;
        const parts: string[] = [];
        if (f.reads > 0) parts.push(`+${f.reads}R`);
        if (f.writes > 0) parts.push(`${f.writes}W`);
        if (f.edits > 0) parts.push(`${f.edits}E`);
        const short = shortenPath(f.path).split('/').pop() || shortenPath(f.path);
        lines.push(`  ├ ${short} (${total}×, ${parts.join('/')})`);
      }
      if (files.length > 3) {
        lines.push(`  └ ...${files.length - 3} more`);
      }
    }

    // Nested commands under Bash
    if (t.name === 'Bash') {
      for (const cmd of metrics.commands.slice(0, 3)) {
        lines.push(`  ├ ${cmd.name} (${cmd.count}×)`);
      }
      if (metrics.commands.length > 3) {
        lines.push(`  └ ...${metrics.commands.length - 3} more`);
      }
    }
  }

  return {
    icon: '\u2699', // ⚙
    title: 'TOOLS',
    subtitle: `${metrics.toolStats.length} types, ${totalCalls} total calls`,
    color: 'green',
    lines,
  };
}

function buildTasksBoxSection(metrics: DashboardMetrics, w: number): BoxSection | null {
  if (metrics.tasks.length === 0) return null;

  const lines: string[] = [];
  for (const t of metrics.tasks) {
    const icon = BOX_STATUS_ICON[t.status] || 'o';
    const left = `${icon} ${t.subject}`;
    const right = t.toolCallCount > 0 ? `${t.toolCallCount} calls` : '';
    lines.push(twoCols(left, right, w));
  }

  return {
    icon: '\u2610', // ☐
    title: 'TASKS',
    subtitle: `${metrics.tasks.length}`,
    color: 'red',
    lines,
  };
}

function buildPlanBoxSection(metrics: DashboardMetrics, w: number): BoxSection | null {
  if (!metrics.plan) return null;

  const lines: string[] = [];
  for (const step of metrics.plan.steps) {
    const icon = BOX_STATUS_ICON[step.status] || 'o';
    const left = `[${icon}] ${step.description}`;
    const taskXref = findMatchingTask(step.description, metrics.tasks);
    const right = taskXref ? `Task #${taskXref.taskId}` : '';
    lines.push(twoCols(left, right, w));
  }

  return {
    icon: '\u25C6', // ◆
    title: 'PLAN',
    subtitle: `"${truncate(metrics.plan.title, 30)}" (${metrics.plan.steps.length} steps)`,
    color: 'cyan',
    lines,
  };
}

function buildSubagentsBoxSection(metrics: DashboardMetrics): BoxSection | null {
  if (metrics.subagents.length === 0) return null;

  const running = metrics.subagents.filter(a => a.status === 'running').length;
  const completed = metrics.subagents.filter(a => a.status === 'completed').length;
  const subtitleParts = [`${metrics.subagents.length}`];
  if (running > 0) subtitleParts.push(`${running} running`);
  if (completed > 0) subtitleParts.push(`${completed} done`);

  const lines: string[] = [];
  for (const s of metrics.subagents) {
    const icon = s.status === 'running' ? '>' : s.isParallel ? '*' : 'v';
    const duration = s.durationMs !== undefined ? ` [${formatDuration(s.durationMs)}]` : '';
    lines.push(`${icon} ${s.subagentType}: "${truncate(s.description, 25)}"${duration}`);
  }

  return {
    icon: '\u229B', // ⊛
    title: 'SUBAGENTS',
    subtitle: subtitleParts.join(', '),
    color: 'magenta',
    lines,
  };
}

function buildTodosBoxSection(metrics: DashboardMetrics): BoxSection | null {
  if (metrics.todos.length === 0) return null;

  const lines: string[] = [];
  for (const todo of metrics.todos) {
    lines.push(`o ${truncate(todo, 40)}`);
  }

  return {
    icon: '\u270E', // ✎
    title: 'TODOs',
    subtitle: `${metrics.todos.length}`,
    color: 'yellow',
    lines,
  };
}

function buildKnowledgeNotesBoxSection(staticData: StaticData): BoxSection | null {
  if (staticData.notes.length === 0) return null;

  const lines: string[] = [];
  const byFile = new Map<string, Array<{ type: string; content: string }>>();
  for (const n of staticData.notes) {
    const file = shortenPath(n.filePath);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ type: n.noteType, content: n.content });
  }

  for (const [file, notes] of byFile) {
    lines.push(file);
    for (const n of notes.slice(0, 3)) {
      const icon = n.type === 'gotcha' ? '[!]' : n.type === 'pattern' ? '[~]' : '[#]';
      lines.push(`  ${icon} ${truncate(n.content, 38)}`);
    }
  }

  return {
    icon: '\u00A7', // §
    title: 'KNOWLEDGE NOTES',
    subtitle: `${staticData.notes.length}`,
    color: 'yellow',
    lines,
  };
}

/**
 * Render the mind map as a boxed ASCII layout.
 * Returns an array of lines (no trailing newline).
 *
 * Options:
 * - `blessedTags` — emit `{color-fg}` blessed tags instead of ANSI escapes
 * - `columns` — available content width for box sizing
 * - `center` — center boxes horizontally (default: true)
 */
export function renderMindMapBoxed(
  metrics: DashboardMetrics,
  staticData: StaticData,
  options?: BoxedRenderOptions,
): string[] {
  const cols = options?.columns;
  const doCenter = options?.center !== false;
  const boxW = getBoxWidth(cols);
  const out: string[] = [];

  // ── Session header (double-line box) ──
  const sessionId = (metrics.sessionStartTime || 'unknown').substring(0, 8);
  const totalTools = metrics.toolStats.reduce((s, t) => s + t.calls, 0);
  const headerLines = [
    `\u25B8 SESSION [${sessionId}] \u2014 claude-code`,
    `${metrics.fileTouches.length} files · ${totalTools} tool calls · ${metrics.tasks.length} tasks`,
  ];
  out.push(...indentBox(renderDoubleBox(headerLines, boxW), boxW, doCenter, cols));

  // ── Build sections ──
  const inner = boxW - 6;
  const sections: BoxSection[] = [];
  const toolsSection = buildToolsBoxSection(metrics);
  if (toolsSection) sections.push(toolsSection);
  const tasksSection = buildTasksBoxSection(metrics, inner);
  if (tasksSection) sections.push(tasksSection);
  const planSection = buildPlanBoxSection(metrics, inner);
  if (planSection) sections.push(planSection);
  const subagentsSection = buildSubagentsBoxSection(metrics);
  if (subagentsSection) sections.push(subagentsSection);
  const todosSection = buildTodosBoxSection(metrics);
  if (todosSection) sections.push(todosSection);
  const notesSection = buildKnowledgeNotesBoxSection(staticData);
  if (notesSection) sections.push(notesSection);

  // ── Render each section with stem connector ──
  for (const section of sections) {
    out.push(...indentBox(renderStem(boxW), boxW, doCenter, cols));
    const colorOpen = options?.blessedTags
      ? `{${section.color}-fg}`
      : (ANSI[section.color] || '');
    const colorClose = options?.blessedTags
      ? `{/${section.color}-fg}`
      : ANSI.reset;
    const header = `${section.icon} ${colorOpen}${section.title}${colorClose} ─── ${section.subtitle}`;
    const sectionBox = renderSingleBox(header, section.lines, boxW);
    out.push(...indentBox(sectionBox, boxW, doCenter, cols));
  }

  return out;
}
