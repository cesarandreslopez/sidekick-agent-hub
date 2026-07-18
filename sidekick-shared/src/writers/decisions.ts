import * as crypto from 'crypto';
import { getProjectDataPath, resolveProjectIdentity } from '../paths';
import {
  DECISION_LOG_SCHEMA_VERSION,
  type DecisionEntry,
  type DecisionLogStore,
  type DecisionSource,
} from '../types/decisionLog';
import { updateJsonStoreAtomic } from './atomic';

function emptyDecisionStore(): DecisionLogStore {
  return {
    schemaVersion: DECISION_LOG_SCHEMA_VERSION,
    decisions: {},
    lastSessionId: 'cli',
    lastSaved: new Date().toISOString(),
  };
}

export function decisionFingerprint(
  decision: Pick<DecisionEntry, 'source' | 'description'>,
): string {
  return `${decision.source}::${decision.description.toLowerCase().trim()}`;
}

export async function addDecision(
  cwd: string,
  description: string,
  options: {
    rationale?: string;
    chosenOption?: string;
    alternatives?: string[];
    tags?: string[];
    source?: DecisionSource;
  } = {},
): Promise<{ decision: DecisionEntry; added: boolean }> {
  const project = resolveProjectIdentity(cwd);
  const filePath = getProjectDataPath(project.canonicalSlug, 'decisions');
  const decision: DecisionEntry = {
    id: crypto.randomUUID(),
    description: description.trim(),
    rationale: options.rationale?.trim() || 'Captured from the Sidekick CLI.',
    chosenOption: options.chosenOption?.trim() || description.trim(),
    alternatives: options.alternatives,
    source: options.source ?? 'text_pattern',
    sessionId: 'cli',
    timestamp: new Date().toISOString(),
    tags: options.tags,
  };
  let added = false;
  let persisted = decision;
  await updateJsonStoreAtomic(filePath, emptyDecisionStore, (store) => {
    const fingerprint = decisionFingerprint(decision);
    const duplicate = Object.values(store.decisions).find(
      (entry) => decisionFingerprint(entry) === fingerprint,
    );
    if (duplicate) {
      persisted = duplicate;
      return store;
    }
    added = true;
    return {
      ...store,
      schemaVersion: DECISION_LOG_SCHEMA_VERSION,
      decisions: { ...store.decisions, [decision.id]: decision },
      lastSessionId: 'cli',
      lastSaved: decision.timestamp,
    };
  });
  return { decision: persisted, added };
}
