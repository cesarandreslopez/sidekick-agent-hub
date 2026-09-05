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
  resolveProjectIdentity,
  summarizeTokens,
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
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Every billed token for the day (see `summarizeTokens`). */
  totalTokens: number;
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
  const project = resolveProjectIdentity(workspacePath);

  // Load history (global, not slug-dependent)
  const history = await readHistory().catch(() => null);

  // Try each slug, preferring raw (extension-written) data
  const [tasks, decisions, notes] = await Promise.all([
    readTasks(project, { status: 'all' }).catch(() => []),
    readDecisions(project).catch(() => []),
    readNotes(project).catch(() => []),
  ]);
  let plans: PersistedPlan[] = [];

  for (const slug of project.candidates) {
    plans = await readPlans(slug).catch(() => []);
    if (plans.length > 0) break;
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
      cacheWriteTokens: day.tokens.cacheWriteTokens,
      cacheReadTokens: day.tokens.cacheReadTokens,
      totalTokens: summarizeTokens(day.tokens).total,
      totalCost: day.totalCost,
      messageCount: day.messageCount,
      modelUsage: day.modelUsage.map((m) => ({ model: m.model, calls: m.calls })),
      toolUsage: day.toolUsage.map((t) => ({ tool: t.tool, calls: t.calls })),
    });
  }

  return records;
}

function computeTotals(history: HistoricalDataStore | null): {
  tokens: number;
  cost: number;
  sessions: number;
} {
  if (!history?.allTime) return { tokens: 0, cost: 0, sessions: 0 };
  const at = history.allTime;
  return {
    tokens: summarizeTokens(at.tokens).total,
    cost: at.totalCost,
    sessions: at.sessionCount,
  };
}
