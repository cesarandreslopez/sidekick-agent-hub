/**
 * @fileoverview Cross-session knowledge note persistence service.
 *
 * Persists knowledge notes (gotchas, patterns, guidelines, tips) attached to files
 * with lifecycle staleness tracking.
 *
 * Storage location: ~/.config/sidekick/knowledge-notes/{projectSlug}.json
 *
 * @module services/KnowledgeNoteService
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type {
  KnowledgeNote,
  KnowledgeNoteStore,
  KnowledgeNoteDisplay,
  KnowledgeNoteType,
  KnowledgeNoteSource,
  KnowledgeNoteStatus,
  KnowledgeNoteImportance,
} from '../types/knowledgeNote';
import {
  KNOWLEDGE_NOTE_SCHEMA_VERSION,
  IMPORTANCE_DECAY_FACTORS,
  STALENESS_THRESHOLDS,
} from '../types/knowledgeNote';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

function createEmptyStore(): KnowledgeNoteStore {
  return {
    schemaVersion: KNOWLEDGE_NOTE_SCHEMA_VERSION,
    notesByFile: {},
    lastSaved: new Date().toISOString(),
    totalNotes: 0,
  };
}

export interface AddNoteOptions {
  noteType: KnowledgeNoteType;
  content: string;
  filePath: string;
  title?: string;
  lineRange?: { start: number; end: number };
  codeSnippet?: string;
  source?: KnowledgeNoteSource;
  importance?: KnowledgeNoteImportance;
  sessionId?: string;
  tags?: string[];
}

export interface NoteFilter {
  status?: KnowledgeNoteStatus[];
  noteType?: KnowledgeNoteType[];
  filePath?: string;
  query?: string;
}

/**
 * Service for persisting knowledge notes across sessions.
 */
export class KnowledgeNoteService extends PersistenceService<KnowledgeNoteStore> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(projectSlug: string) {
    super(
      resolveSidekickDataPath('knowledge-notes', `${projectSlug}.json`),
      'Knowledge note',
      KNOWLEDGE_NOTE_SCHEMA_VERSION,
      createEmptyStore,
    );
  }

  protected override onStoreLoaded(): void {
    this.recountNotes();
    log(`Loaded persisted knowledge notes: ${this.store.totalNotes} entries`);
  }

  /**
   * Adds a new knowledge note and returns its ID.
   */
  addNote(options: AddNoteOptions): string {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const note: KnowledgeNote = {
      id,
      noteType: options.noteType,
      content: options.content,
      title: options.title,
      filePath: options.filePath,
      lineRange: options.lineRange,
      codeSnippet: options.codeSnippet,
      source: options.source ?? 'manual',
      status: 'active',
      importance: options.importance ?? 'medium',
      sessionId: options.sessionId,
      createdAt: now,
      updatedAt: now,
      lastReviewedAt: now,
      tags: options.tags,
    };

    if (!this.store.notesByFile[options.filePath]) {
      this.store.notesByFile[options.filePath] = [];
    }

    this.store.notesByFile[options.filePath].push(note);
    this.store.totalNotes++;
    this.markDirtyAndNotify();
    log(`Added knowledge note ${id} to ${options.filePath}`);

    return id;
  }

  /**
   * Updates an existing note by ID.
   */
  updateNote(id: string, updates: Partial<Pick<KnowledgeNote, 'content' | 'title' | 'noteType' | 'importance' | 'tags' | 'status'>>): boolean {
    const note = this.findNoteById(id);
    if (!note) return false;

    Object.assign(note, updates, { updatedAt: new Date().toISOString() });
    this.markDirtyAndNotify();
    return true;
  }

  /**
   * Deletes a note by ID.
   */
  deleteNote(id: string): boolean {
    for (const [filePath, notes] of Object.entries(this.store.notesByFile)) {
      const idx = notes.findIndex(n => n.id === id);
      if (idx !== -1) {
        notes.splice(idx, 1);
        if (notes.length === 0) {
          delete this.store.notesByFile[filePath];
        }
        this.store.totalNotes--;
        this.markDirtyAndNotify();
        log(`Deleted knowledge note ${id}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Confirms a note, resetting its review timestamp and status to active.
   */
  confirmNote(id: string): boolean {
    const note = this.findNoteById(id);
    if (!note) return false;

    note.lastReviewedAt = new Date().toISOString();
    note.updatedAt = new Date().toISOString();
    note.status = 'active';
    this.markDirtyAndNotify();
    return true;
  }

  /**
   * Returns notes for a specific relative file path.
   */
  getNotesForFile(relativePath: string): KnowledgeNote[] {
    return this.store.notesByFile[relativePath] ?? [];
  }

  /**
   * Returns all notes formatted for display, optionally filtered.
   */
  getAllNotes(filter?: NoteFilter): KnowledgeNoteDisplay[] {
    let allNotes: KnowledgeNote[] = [];

    for (const notes of Object.values(this.store.notesByFile)) {
      allNotes.push(...notes);
    }

    if (filter) {
      if (filter.status && filter.status.length > 0) {
        allNotes = allNotes.filter(n => filter.status!.includes(n.status));
      }
      if (filter.noteType && filter.noteType.length > 0) {
        allNotes = allNotes.filter(n => filter.noteType!.includes(n.noteType));
      }
      if (filter.filePath) {
        allNotes = allNotes.filter(n => n.filePath === filter.filePath);
      }
      if (filter.query && filter.query.trim().length > 0) {
        const q = filter.query.toLowerCase().trim();
        allNotes = allNotes.filter(
          n =>
            n.content.toLowerCase().includes(q) ||
            (n.title?.toLowerCase().includes(q) ?? false) ||
            n.filePath.toLowerCase().includes(q)
        );
      }
    }

    // Sort by updated time descending
    allNotes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return allNotes.map(n => ({
      id: n.id,
      noteType: n.noteType,
      content: n.content,
      title: n.title,
      filePath: n.filePath,
      lineRange: n.lineRange,
      status: n.status,
      importance: n.importance,
      source: n.source,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      tags: n.tags,
    }));
  }

  /**
   * Returns active notes (for injection into prompts, mind map, etc).
   */
  getActiveNotes(): KnowledgeNote[] {
    const active: KnowledgeNote[] = [];
    for (const notes of Object.values(this.store.notesByFile)) {
      for (const note of notes) {
        if (note.status === 'active' || note.status === 'needs_review') {
          active.push(note);
        }
      }
    }
    return active;
  }

  /**
   * Returns all file paths that have notes.
   */
  getFilesWithNotes(): string[] {
    return Object.keys(this.store.notesByFile);
  }

  getNoteCount(): number {
    return this.store.totalNotes;
  }

  /**
   * Updates staleness status for notes based on file changes.
   *
   * @param changedFilePaths - Relative paths of files that changed. If undefined, checks all.
   * @param deletedFilePaths - Relative paths of files that were deleted.
   */
  updateStaleness(changedFilePaths?: string[], deletedFilePaths?: string[]): void {
    let updated = false;

    // Handle deleted files
    if (deletedFilePaths) {
      for (const deletedPath of deletedFilePaths) {
        const notes = this.store.notesByFile[deletedPath];
        if (notes) {
          for (const note of notes) {
            if (note.status !== 'obsolete') {
              note.status = 'obsolete';
              note.updatedAt = new Date().toISOString();
              updated = true;
            }
          }
        }
      }
    }

    // Handle changed files - check staleness score
    const pathsToCheck = changedFilePaths ?? Object.keys(this.store.notesByFile);

    for (const filePath of pathsToCheck) {
      const notes = this.store.notesByFile[filePath];
      if (!notes) continue;

      for (const note of notes) {
        if (note.status === 'obsolete') continue;

        const score = this.calculateStalenessScore(note);
        const newStatus = this.determineStatus(score, note.status);

        if (newStatus !== note.status) {
          note.status = newStatus;
          note.updatedAt = new Date().toISOString();
          updated = true;
        }
      }
    }

    if (updated) {
      this.markDirtyAndNotify();
    }
  }

  /**
   * Calculates staleness score: ageDays / decayFactor.
   * Lower importance decays faster (higher score for same age).
   */
  calculateStalenessScore(note: KnowledgeNote): number {
    const reviewedAt = new Date(note.lastReviewedAt).getTime();
    const now = Date.now();
    const ageDays = (now - reviewedAt) / (1000 * 60 * 60 * 24);
    const decayFactor = IMPORTANCE_DECAY_FACTORS[note.importance];
    return ageDays / decayFactor;
  }

  override dispose(): void {
    this._onDidChange.dispose();
    super.dispose();
  }

  private determineStatus(score: number, currentStatus: KnowledgeNoteStatus): KnowledgeNoteStatus {
    if (currentStatus === 'obsolete') return 'obsolete';

    if (score >= STALENESS_THRESHOLDS.stale) {
      return 'stale';
    }
    if (score >= STALENESS_THRESHOLDS.needsReview) {
      return 'needs_review';
    }
    return 'active';
  }

  private findNoteById(id: string): KnowledgeNote | undefined {
    for (const notes of Object.values(this.store.notesByFile)) {
      const note = notes.find(n => n.id === id);
      if (note) return note;
    }
    return undefined;
  }

  private recountNotes(): void {
    let count = 0;
    for (const notes of Object.values(this.store.notesByFile)) {
      count += notes.length;
    }
    this.store.totalNotes = count;
  }

  private markDirtyAndNotify(): void {
    this.markDirty();
    this._onDidChange.fire();
  }
}
