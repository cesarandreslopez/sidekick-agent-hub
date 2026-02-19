/**
 * @fileoverview Type definitions for knowledge notes system.
 *
 * Captures reusable knowledge (gotchas, patterns, guidelines, tips) attached
 * to files with lifecycle staleness tracking. Three phases:
 * 1. Manual notes (user-created via command)
 * 2. Auto-extraction from session analysis
 * 3. Auto-surfacing in guidance and mind map
 *
 * Storage location: ~/.config/sidekick/knowledge-notes/{projectSlug}.json
 *
 * @module types/knowledgeNote
 */

/** Current schema version for knowledge note store */
export const KNOWLEDGE_NOTE_SCHEMA_VERSION = 1;

/** Type of knowledge captured */
export type KnowledgeNoteType = 'gotcha' | 'pattern' | 'guideline' | 'tip';

/** How a note was created */
export type KnowledgeNoteSource = 'manual' | 'auto_error' | 'auto_recovery' | 'auto_guidance';

/** Lifecycle status of a note */
export type KnowledgeNoteStatus = 'active' | 'needs_review' | 'stale' | 'obsolete';

/** Importance level affecting staleness decay rate */
export type KnowledgeNoteImportance = 'critical' | 'high' | 'medium' | 'low';

/**
 * Decay factors per importance level.
 * Higher factor = slower staleness (critical notes stay fresh longer).
 * Staleness score = ageDays / decayFactor
 */
export const IMPORTANCE_DECAY_FACTORS: Record<KnowledgeNoteImportance, number> = {
  critical: 2.0,
  high: 1.5,
  medium: 1.0,
  low: 0.5,
};

/**
 * Staleness thresholds in days (after decay factor applied).
 * - needsReview: note should be reviewed
 * - stale: note is likely outdated
 */
export const STALENESS_THRESHOLDS = {
  needsReview: 30,
  stale: 90,
};

/**
 * A single knowledge note attached to a file.
 */
export interface KnowledgeNote {
  /** Unique identifier (crypto.randomUUID()) */
  id: string;

  /** Type of knowledge */
  noteType: KnowledgeNoteType;

  /** Note content / description */
  content: string;

  /** Optional short title */
  title?: string;

  /** Relative file path within the workspace */
  filePath: string;

  /** Optional line range the note applies to */
  lineRange?: { start: number; end: number };

  /** Optional code snippet the note was created from */
  codeSnippet?: string;

  /** How this note was created */
  source: KnowledgeNoteSource;

  /** Current lifecycle status */
  status: KnowledgeNoteStatus;

  /** Importance level */
  importance: KnowledgeNoteImportance;

  /** Session ID where the note was created */
  sessionId?: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** ISO 8601 last update timestamp */
  updatedAt: string;

  /** ISO 8601 last review timestamp (resets staleness) */
  lastReviewedAt: string;

  /** Optional categorization tags */
  tags?: string[];
}

/**
 * On-disk store for persisted knowledge notes.
 */
export interface KnowledgeNoteStore {
  /** Schema version for future migrations */
  schemaVersion: number;

  /** Notes grouped by relative file path */
  notesByFile: Record<string, KnowledgeNote[]>;

  /** ISO 8601 timestamp of last save */
  lastSaved: string;

  /** Total number of notes in the store */
  totalNotes: number;
}

/**
 * Knowledge note formatted for tree view / webview display.
 */
export interface KnowledgeNoteDisplay {
  id: string;
  noteType: KnowledgeNoteType;
  content: string;
  title?: string;
  filePath: string;
  lineRange?: { start: number; end: number };
  status: KnowledgeNoteStatus;
  importance: KnowledgeNoteImportance;
  source: KnowledgeNoteSource;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

/**
 * Auto-extracted knowledge candidate awaiting user confirmation.
 */
export interface KnowledgeCandidateDisplay {
  /** Suggested note type */
  noteType: KnowledgeNoteType;

  /** Suggested content */
  content: string;

  /** File path the candidate relates to */
  filePath: string;

  /** How this candidate was extracted */
  source: KnowledgeNoteSource;

  /** Confidence score (0-1) */
  confidence: number;

  /** Supporting evidence for the extraction */
  evidence: string;
}
