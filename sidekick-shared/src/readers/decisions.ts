/**
 * Reader for persisted decisions.
 */

import type { DecisionEntry, DecisionLogStore } from '../types/decisionLog';
import { getProjectDataPath } from '../paths';
import { readJsonStore } from './helpers';

export interface ReadDecisionsOptions {
  search?: string;
  file?: string;
  limit?: number;
}

export async function readDecisions(slug: string, opts?: ReadDecisionsOptions): Promise<DecisionEntry[]> {
  const filePath = getProjectDataPath(slug, 'decisions');
  const store = await readJsonStore<DecisionLogStore>(filePath);
  if (!store) return [];

  let decisions = Object.values(store.decisions);

  // Sort by timestamp descending
  decisions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (opts?.search) {
    const q = opts.search.toLowerCase();
    decisions = decisions.filter(d =>
      d.description.toLowerCase().includes(q) ||
      d.rationale.toLowerCase().includes(q) ||
      d.chosenOption.toLowerCase().includes(q)
    );
  }

  if (opts?.limit && opts.limit > 0) {
    decisions = decisions.slice(0, opts.limit);
  }

  return decisions;
}
