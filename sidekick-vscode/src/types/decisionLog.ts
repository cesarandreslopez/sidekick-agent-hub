/**
 * @fileoverview Type definitions for cross-session decision log persistence.
 *
 * Captures implicit and explicit decisions made during Claude Code sessions:
 * package manager choices, architecture selections, user-answered questions, etc.
 *
 * Storage location: ~/.config/sidekick/decisions/{projectSlug}.json
 *
 * @module types/decisionLog
 */

/** Current schema version for decision log store */
export const DECISION_LOG_SCHEMA_VERSION = 1;

/** How a decision was detected */
export type DecisionSource = 'recovery_pattern' | 'plan_mode' | 'user_question' | 'text_pattern';

/**
 * A single decision entry persisted to disk.
 */
export interface DecisionEntry {
  /** Unique identifier (crypto.randomUUID()) */
  id: string;

  /** What was decided (e.g., "Use pnpm instead of npm") */
  description: string;

  /** Why this decision was made */
  rationale: string;

  /** Options that were considered but not chosen */
  alternatives?: string[];

  /** The option that was selected */
  chosenOption: string;

  /** How this decision was detected */
  source: DecisionSource;

  /** Session where this decision was captured */
  sessionId: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Optional categorization tags */
  tags?: string[];
}

/**
 * On-disk store for persisted decisions.
 */
export interface DecisionLogStore {
  /** Schema version for future migrations */
  schemaVersion: number;

  /** Persisted decisions keyed by id */
  decisions: Record<string, DecisionEntry>;

  /** Session ID of the most recently saved session */
  lastSessionId: string;

  /** ISO 8601 timestamp of last save */
  lastSaved: string;
}

/**
 * Decision entry formatted for webview display.
 */
export interface DecisionEntryDisplay {
  id: string;
  description: string;
  rationale: string;
  chosenOption: string;
  source: string;
  timestamp: string;
  alternatives?: string[];
  tags?: string[];
}
