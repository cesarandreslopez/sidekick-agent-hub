/**
 * Context composer — aggregates all readers with fidelity tiers.
 */

import type { PersistedTask } from '../types/taskPersistence';
import type { DecisionEntry } from '../types/decisionLog';
import type { KnowledgeNote } from '../types/knowledgeNote';
import type { TokenTotals } from '../types/historicalData';
import type { SessionProvider, SessionFileStats, ProviderId } from '../providers/types';
import { readTasks } from '../readers/tasks';
import { readDecisions } from '../readers/decisions';
import { readNotes } from '../readers/notes';
import { readHistory } from '../readers/history';
import { readLatestHandoff } from '../readers/handoff';
import { createEmptyTokenTotals } from '../types/historicalData';

export type Fidelity = 'full' | 'compact' | 'brief';

export interface ContextResult {
  provider: ProviderId;
  tasks: { items: PersistedTask[]; total: number };
  decisions: { items: DecisionEntry[]; total: number };
  notes: { items: KnowledgeNote[]; total: number };
  handoff: string | null;
  stats: { tokens: TokenTotals; cost: number } | null;
  sessionSummaries: SessionFileStats[];
}

export async function composeContext(
  slug: string,
  fidelity: Fidelity,
  provider: SessionProvider,
  workspacePath?: string
): Promise<ContextResult> {
  // Fetch all data in parallel
  const [allTasks, allDecisions, allNotes, history, handoff] = await Promise.all([
    readTasks(slug),
    readDecisions(slug),
    readNotes(slug),
    readHistory(),
    readLatestHandoff(slug),
  ]);

  // Get session summaries
  const sessionFiles = workspacePath ? provider.findAllSessions(workspacePath) : [];
  let sessionSummaries: SessionFileStats[] = [];

  // Read stats for session files based on fidelity
  const sessionLimit = fidelity === 'full' ? 5 : fidelity === 'compact' ? 2 : 1;
  const sessionPaths = sessionFiles.slice(0, sessionLimit);
  for (const sp of sessionPaths) {
    try {
      sessionSummaries.push(provider.readSessionStats(sp));
    } catch { /* skip */ }
  }

  // Apply fidelity filtering
  let tasks: PersistedTask[];
  let decisions: DecisionEntry[];
  let notes: KnowledgeNote[];
  let stats: { tokens: TokenTotals; cost: number } | null = null;

  switch (fidelity) {
    case 'full':
      tasks = allTasks;
      decisions = allDecisions;
      notes = allNotes.filter(n => n.status === 'active' || n.status === 'needs_review');
      if (history) {
        stats = { tokens: { ...history.allTime.tokens }, cost: history.allTime.totalCost };
      }
      break;

    case 'compact':
      tasks = allTasks.filter(t => t.status === 'pending');
      decisions = allDecisions.slice(0, 10);
      notes = allNotes.filter(n => n.status === 'active');
      if (history) {
        stats = { tokens: { ...history.allTime.tokens }, cost: history.allTime.totalCost };
      }
      break;

    case 'brief':
      tasks = allTasks.filter(t => t.status === 'pending').slice(0, 3);
      decisions = []; // Count only
      notes = allNotes.filter(n => n.importance === 'critical');
      stats = null;
      break;
  }

  return {
    provider: provider.id,
    tasks: { items: tasks, total: allTasks.length },
    decisions: { items: decisions, total: allDecisions.length },
    notes: { items: notes, total: allNotes.length },
    handoff,
    stats,
    sessionSummaries,
  };
}
