/**
 * Loads persisted data from ~/.config/sidekick/ for static dashboard pages.
 */

import {
  readHistory,
  readTasks,
  readDecisions,
  readNotes,
  readPlans,
  readClaudeCodePlanFiles,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';
import type {
  HistoricalDataStore,
  DailyData,
  PersistedTask,
  DecisionEntry,
  KnowledgeNote,
  PersistedPlan,
} from 'sidekick-shared';

// ── Public types ──

export interface SessionRecord {
  date: string;
  sessionCount: number;
  duration?: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  messageCount: number;
  modelUsage: Array<{ model: string; calls: number }>;
  toolUsage: Array<{ tool: string; calls: number }>;
}

export interface StaticData {
  sessions: SessionRecord[];
  tasks: PersistedTask[];
  decisions: DecisionEntry[];
  notes: KnowledgeNote[];
  plans: PersistedPlan[];
  totalTokens: number;
  totalCost: number;
  totalSessions: number;
}

// ── Loader ──

export async function loadStaticData(workspacePath?: string): Promise<StaticData> {
  // Try raw slug first (matches VS Code extension behavior — no symlink resolution),
  // fall back to resolved slug if no data found.
  const rawSlug = getProjectSlugRaw(workspacePath);
  const resolvedSlug = getProjectSlug(workspacePath);
  const slugs = rawSlug !== resolvedSlug ? [rawSlug, resolvedSlug] : [rawSlug];

  // Load history (global, not slug-dependent)
  const history = await readHistory().catch(() => null);

  // Try each slug, preferring raw (extension-written) data
  let tasks: PersistedTask[] = [];
  let decisions: DecisionEntry[] = [];
  let notes: KnowledgeNote[] = [];
  let plans: PersistedPlan[] = [];

  for (const slug of slugs) {
    const [t, d, n, p] = await Promise.all([
      tasks.length === 0 ? readTasks(slug, { status: 'all' }).catch(() => []) : tasks,
      decisions.length === 0 ? readDecisions(slug).catch(() => []) : decisions,
      notes.length === 0 ? readNotes(slug).catch(() => []) : notes,
      plans.length === 0 ? readPlans(slug).catch(() => []) : plans,
    ]);
    if (tasks.length === 0) tasks = t;
    if (decisions.length === 0) decisions = d;
    if (notes.length === 0) notes = n;
    if (plans.length === 0) plans = p;
  }

  // Supplement with raw plan files from ~/.claude/plans/ (always available,
  // even before the persistence pipeline runs)
  if (plans.length === 0) {
    plans = await readClaudeCodePlanFiles(workspacePath).catch(() => []);
  }

  const sessions = extractSessions(history);
  const totals = computeTotals(history);

  return {
    sessions,
    tasks,
    decisions,
    notes,
    plans,
    totalTokens: totals.tokens,
    totalCost: totals.cost,
    totalSessions: totals.sessions,
  };
}

function extractSessions(history: HistoricalDataStore | null): SessionRecord[] {
  if (!history?.daily) return [];

  const records: SessionRecord[] = [];
  const days = Object.values(history.daily) as DailyData[];

  // Sort by date descending
  days.sort((a, b) => b.date.localeCompare(a.date));

  for (const day of days) {
    records.push({
      date: day.date,
      sessionCount: day.sessionCount,
      inputTokens: day.tokens.inputTokens,
      outputTokens: day.tokens.outputTokens,
      totalCost: day.totalCost,
      messageCount: day.messageCount,
      modelUsage: day.modelUsage.map(m => ({ model: m.model, calls: m.calls })),
      toolUsage: day.toolUsage.map(t => ({ tool: t.tool, calls: t.calls })),
    });
  }

  return records;
}

function computeTotals(history: HistoricalDataStore | null): { tokens: number; cost: number; sessions: number } {
  if (!history?.allTime) return { tokens: 0, cost: 0, sessions: 0 };
  const at = history.allTime;
  return {
    tokens: at.tokens.inputTokens + at.tokens.outputTokens,
    cost: at.totalCost,
    sessions: at.sessionCount,
  };
}
