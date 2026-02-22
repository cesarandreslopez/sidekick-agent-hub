/**
 * On-disk schema types for cross-session decision log.
 * Canonical source: sidekick-vscode/src/types/decisionLog.ts
 */

export const DECISION_LOG_SCHEMA_VERSION = 1;

export type DecisionSource = 'recovery_pattern' | 'plan_mode' | 'user_question' | 'text_pattern';

export interface DecisionEntry {
  id: string;
  description: string;
  rationale: string;
  alternatives?: string[];
  chosenOption: string;
  source: DecisionSource;
  sessionId: string;
  timestamp: string;
  tags?: string[];
}

export interface DecisionLogStore {
  schemaVersion: number;
  decisions: Record<string, DecisionEntry>;
  lastSessionId: string;
  lastSaved: string;
}
