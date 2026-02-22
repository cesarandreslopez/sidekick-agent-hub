/**
 * On-disk schema types for knowledge notes.
 * Canonical source: sidekick-vscode/src/types/knowledgeNote.ts
 */

export const KNOWLEDGE_NOTE_SCHEMA_VERSION = 1;

export type KnowledgeNoteType = 'gotcha' | 'pattern' | 'guideline' | 'tip';
export type KnowledgeNoteSource = 'manual' | 'auto_error' | 'auto_recovery' | 'auto_guidance';
export type KnowledgeNoteStatus = 'active' | 'needs_review' | 'stale' | 'obsolete';
export type KnowledgeNoteImportance = 'critical' | 'high' | 'medium' | 'low';

export const IMPORTANCE_DECAY_FACTORS: Record<KnowledgeNoteImportance, number> = {
  critical: 2.0,
  high: 1.5,
  medium: 1.0,
  low: 0.5,
};

export const STALENESS_THRESHOLDS = {
  needsReview: 30,
  stale: 90,
};

export interface KnowledgeNote {
  id: string;
  noteType: KnowledgeNoteType;
  content: string;
  title?: string;
  filePath: string;
  lineRange?: { start: number; end: number };
  codeSnippet?: string;
  source: KnowledgeNoteSource;
  status: KnowledgeNoteStatus;
  importance: KnowledgeNoteImportance;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastReviewedAt: string;
  tags?: string[];
}

export interface KnowledgeNoteStore {
  schemaVersion: number;
  notesByFile: Record<string, KnowledgeNote[]>;
  lastSaved: string;
  totalNotes: number;
}
