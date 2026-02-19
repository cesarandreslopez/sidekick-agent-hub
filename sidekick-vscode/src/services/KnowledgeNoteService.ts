/**
 * @fileoverview Cross-session knowledge note persistence service.
 *
 * Persists knowledge notes (gotchas, patterns, guidelines, tips) attached to files
 * with lifecycle staleness tracking. Follows the DecisionLogService pattern:
 * dirty tracking, debounced saves, synchronous dispose.
 *
 * Storage location: ~/.config/sidekick/knowledge-notes/{projectSlug}.json
 *
 * @module services/KnowledgeNoteService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { log, logError } from './Logger';

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
export class KnowledgeNoteService implements vscode.Disposable {
  private store: KnowledgeNoteStore;
  private dataFilePath: string;
  private isDirty: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly projectSlug: string) {
    this.store = createEmptyStore();
    this.dataFilePath = this.getDataFilePath();
  }

  private getDataFilePath(): string {
    let configDir: string;

    if (process.platform === 'win32') {
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'knowledge-notes');
    } else {
      configDir = path.join(os.homedir(), '.config', 'sidekick', 'knowledge-notes');
    }

    return path.join(configDir, `${this.projectSlug}.json`);
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created knowledge notes directory: ${dir}`);
      }

      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as KnowledgeNoteStore;

        if (loaded.schemaVersion !== KNOWLEDGE_NOTE_SCHEMA_VERSION) {
          log(`Knowledge note schema version mismatch: ${loaded.schemaVersion} vs ${KNOWLEDGE_NOTE_SCHEMA_VERSION}`);
        }

        this.store = loaded;
        this.recountNotes();
        log(`Loaded persisted knowledge notes: ${this.store.totalNotes} entries`);
      } else {
        this.store = createEmptyStore();
        log('Initialized new knowledge note store');
      }
    } catch (error) {
      logError('Failed to load persisted knowledge notes, starting with empty store', error);
      this.store = createEmptyStore();
    }
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
    this.markDirty();
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
    this.markDirty();
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
        this.markDirty();
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
    this.markDirty();
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
   * Lifecycle transitions:
   * - Active -> NeedsReview: file modified AND staleness score > needsReview threshold
   * - NeedsReview -> Stale: score > stale threshold
   * - Any -> Obsolete: file deleted from workspace
   * - Confirm resets lastReviewedAt and status back to Active
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
      this.markDirty();
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

  private markDirty(): void {
    this.isDirty = true;
    this.scheduleSave();
    this._onDidChange.fire();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (!this.isDirty) return;

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Knowledge note data saved to disk');
    } catch (error) {
      logError('Failed to save knowledge note data', error);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log('Knowledge note data saved on dispose');
      } catch (error) {
        logError('Failed to save knowledge note data on dispose', error);
      }
    }

    this._onDidChange.dispose();
  }
}
