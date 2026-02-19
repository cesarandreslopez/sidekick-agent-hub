/**
 * @fileoverview Tests for KnowledgeNoteService.
 *
 * Tests add/update/delete, staleness lifecycle, persistence round-trip,
 * filtering, and confirm behavior.
 *
 * @module KnowledgeNoteService.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KnowledgeNoteService } from './KnowledgeNoteService';
import type { KnowledgeNoteStore } from '../types/knowledgeNote';
import { KNOWLEDGE_NOTE_SCHEMA_VERSION, STALENESS_THRESHOLDS } from '../types/knowledgeNote';

// Mock vscode module
vi.mock('vscode', () => ({
  Disposable: { from: vi.fn() },
  EventEmitter: class {
    private listeners: Array<() => void> = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire() { this.listeners.forEach(l => l()); }
    dispose() { this.listeners = []; }
  },
}));

// Mock Logger
vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

let tmpDir: string;

function createService(slug = 'test-project'): KnowledgeNoteService {
  const service = new KnowledgeNoteService(slug);
  const dataFilePath = path.join(tmpDir, `${slug}.json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).dataFilePath = dataFilePath;
  return service;
}

describe('KnowledgeNoteService', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-knowledge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates empty store when no file exists', async () => {
      const service = createService();
      await service.initialize();

      expect(service.getNoteCount()).toBe(0);
      expect(service.getAllNotes()).toEqual([]);
    });

    it('loads existing store from disk', async () => {
      const store: KnowledgeNoteStore = {
        schemaVersion: KNOWLEDGE_NOTE_SCHEMA_VERSION,
        notesByFile: {
          'src/foo.ts': [{
            id: 'note-1',
            noteType: 'gotcha',
            content: 'Watch out for null',
            filePath: 'src/foo.ts',
            source: 'manual',
            status: 'active',
            importance: 'medium',
            createdAt: '2026-02-18T10:00:00Z',
            updatedAt: '2026-02-18T10:00:00Z',
            lastReviewedAt: '2026-02-18T10:00:00Z',
          }],
        },
        lastSaved: '2026-02-18T10:00:00Z',
        totalNotes: 1,
      };

      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        JSON.stringify(store)
      );

      const service = createService();
      await service.initialize();

      expect(service.getNoteCount()).toBe(1);
      const notes = service.getAllNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe('Watch out for null');
    });

    it('falls back to empty store on corrupt JSON', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        'not valid json{{{'
      );

      const service = createService();
      await service.initialize();

      expect(service.getNoteCount()).toBe(0);
    });
  });

  describe('addNote', () => {
    it('adds a note and returns its ID', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'gotcha',
        content: 'Requires cache invalidation',
        filePath: 'src/cache.ts',
      });

      expect(id).toBeTruthy();
      expect(service.getNoteCount()).toBe(1);

      const notes = service.getNotesForFile('src/cache.ts');
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe('Requires cache invalidation');
      expect(notes[0].status).toBe('active');
      expect(notes[0].importance).toBe('medium');
      service.dispose();
    });

    it('persists notes via round-trip', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({
        noteType: 'pattern',
        content: 'Always use async/await here',
        filePath: 'src/api.ts',
        importance: 'high',
      });
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      expect(service2.getNoteCount()).toBe(1);
      const notes = service2.getNotesForFile('src/api.ts');
      expect(notes[0].importance).toBe('high');
      service2.dispose();
    });

    it('allows multiple notes on the same file', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Note A', filePath: 'src/foo.ts' });
      service.addNote({ noteType: 'tip', content: 'Note B', filePath: 'src/foo.ts' });

      expect(service.getNoteCount()).toBe(2);
      expect(service.getNotesForFile('src/foo.ts')).toHaveLength(2);
      service.dispose();
    });
  });

  describe('updateNote', () => {
    it('updates note content', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'gotcha',
        content: 'Original content',
        filePath: 'src/foo.ts',
      });

      const updated = service.updateNote(id, { content: 'Updated content' });
      expect(updated).toBe(true);

      const notes = service.getNotesForFile('src/foo.ts');
      expect(notes[0].content).toBe('Updated content');
      service.dispose();
    });

    it('returns false for non-existent ID', async () => {
      const service = createService();
      await service.initialize();

      const updated = service.updateNote('non-existent', { content: 'test' });
      expect(updated).toBe(false);
      service.dispose();
    });
  });

  describe('deleteNote', () => {
    it('removes a note by ID', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'tip',
        content: 'Delete me',
        filePath: 'src/bar.ts',
      });

      expect(service.deleteNote(id)).toBe(true);
      expect(service.getNoteCount()).toBe(0);
      expect(service.getNotesForFile('src/bar.ts')).toHaveLength(0);
      service.dispose();
    });

    it('cleans up empty file entries', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'tip',
        content: 'Only note',
        filePath: 'src/only.ts',
      });

      service.deleteNote(id);
      expect(service.getFilesWithNotes()).not.toContain('src/only.ts');
      service.dispose();
    });

    it('returns false for non-existent ID', async () => {
      const service = createService();
      await service.initialize();

      expect(service.deleteNote('non-existent')).toBe(false);
      service.dispose();
    });
  });

  describe('confirmNote', () => {
    it('resets status to active and updates lastReviewedAt', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'gotcha',
        content: 'Check this',
        filePath: 'src/foo.ts',
      });

      // Manually set to needs_review
      service.updateNote(id, { status: 'needs_review' });

      const confirmed = service.confirmNote(id);
      expect(confirmed).toBe(true);

      const notes = service.getNotesForFile('src/foo.ts');
      expect(notes[0].status).toBe('active');
      service.dispose();
    });
  });

  describe('getAllNotes with filter', () => {
    it('filters by status', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Active', filePath: 'a.ts' });
      const id2 = service.addNote({ noteType: 'tip', content: 'Stale', filePath: 'b.ts' });
      service.updateNote(id2, { status: 'stale' });

      const activeOnly = service.getAllNotes({ status: ['active'] });
      expect(activeOnly).toHaveLength(1);
      expect(activeOnly[0].content).toBe('Active');
      service.dispose();
    });

    it('filters by noteType', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'G1', filePath: 'a.ts' });
      service.addNote({ noteType: 'tip', content: 'T1', filePath: 'a.ts' });
      service.addNote({ noteType: 'pattern', content: 'P1', filePath: 'b.ts' });

      const gotchas = service.getAllNotes({ noteType: ['gotcha'] });
      expect(gotchas).toHaveLength(1);
      expect(gotchas[0].noteType).toBe('gotcha');
      service.dispose();
    });

    it('filters by search query', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Cache invalidation required', filePath: 'a.ts' });
      service.addNote({ noteType: 'tip', content: 'Use async/await', filePath: 'b.ts' });

      const results = service.getAllNotes({ query: 'cache' });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('Cache');
      service.dispose();
    });
  });

  describe('staleness lifecycle', () => {
    it('transitions active → needs_review when score exceeds threshold', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'gotcha',
        content: 'Old note',
        filePath: 'src/old.ts',
        importance: 'medium', // decay factor 1.0
      });

      // Backdate lastReviewedAt to exceed needsReview threshold (30 days with medium importance)
      const notes = service.getNotesForFile('src/old.ts');
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - (STALENESS_THRESHOLDS.needsReview + 1));
      notes[0].lastReviewedAt = pastDate.toISOString();

      service.updateStaleness(['src/old.ts']);

      const updated = service.getNotesForFile('src/old.ts');
      expect(updated[0].status).toBe('needs_review');
      service.dispose();
    });

    it('transitions to stale when score exceeds stale threshold', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({
        noteType: 'gotcha',
        content: 'Very old note',
        filePath: 'src/ancient.ts',
        importance: 'medium',
      });

      const notes = service.getNotesForFile('src/ancient.ts');
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - (STALENESS_THRESHOLDS.stale + 1));
      notes[0].lastReviewedAt = pastDate.toISOString();

      service.updateStaleness(['src/ancient.ts']);

      const updated = service.getNotesForFile('src/ancient.ts');
      expect(updated[0].status).toBe('stale');
      service.dispose();
    });

    it('marks notes as obsolete when file is deleted', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({
        noteType: 'pattern',
        content: 'Deleted file pattern',
        filePath: 'src/deleted.ts',
      });

      service.updateStaleness(undefined, ['src/deleted.ts']);

      const notes = service.getNotesForFile('src/deleted.ts');
      expect(notes[0].status).toBe('obsolete');
      service.dispose();
    });

    it('critical importance decays slower than low importance', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Critical', filePath: 'a.ts', importance: 'critical' });
      service.addNote({ noteType: 'gotcha', content: 'Low', filePath: 'b.ts', importance: 'low' });

      // Set both to same age (35 days ago) - above needsReview threshold for medium
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 35);

      const notesA = service.getNotesForFile('a.ts');
      const notesB = service.getNotesForFile('b.ts');
      notesA[0].lastReviewedAt = pastDate.toISOString();
      notesB[0].lastReviewedAt = pastDate.toISOString();

      service.updateStaleness();

      // Critical: 35 / 2.0 = 17.5 score (below needsReview threshold of 30)
      expect(service.getNotesForFile('a.ts')[0].status).toBe('active');
      // Low: 35 / 0.5 = 70 score (above needsReview but below stale)
      expect(service.getNotesForFile('b.ts')[0].status).toBe('needs_review');
      service.dispose();
    });

    it('confirm resets staleness back to active', async () => {
      const service = createService();
      await service.initialize();

      const id = service.addNote({
        noteType: 'gotcha',
        content: 'Needs review',
        filePath: 'src/review.ts',
      });

      service.updateNote(id, { status: 'needs_review' });
      expect(service.getNotesForFile('src/review.ts')[0].status).toBe('needs_review');

      service.confirmNote(id);
      expect(service.getNotesForFile('src/review.ts')[0].status).toBe('active');
      service.dispose();
    });
  });

  describe('getActiveNotes', () => {
    it('returns only active and needs_review notes', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Active', filePath: 'a.ts' });
      const id2 = service.addNote({ noteType: 'tip', content: 'Needs review', filePath: 'b.ts' });
      const id3 = service.addNote({ noteType: 'pattern', content: 'Stale', filePath: 'c.ts' });
      const id4 = service.addNote({ noteType: 'guideline', content: 'Obsolete', filePath: 'd.ts' });

      service.updateNote(id2, { status: 'needs_review' });
      service.updateNote(id3, { status: 'stale' });
      service.updateNote(id4, { status: 'obsolete' });

      const active = service.getActiveNotes();
      expect(active).toHaveLength(2);
      expect(active.map(n => n.content).sort()).toEqual(['Active', 'Needs review']);
      service.dispose();
    });
  });

  describe('dispose', () => {
    it('writes dirty data synchronously on dispose', async () => {
      const service = createService();
      await service.initialize();

      service.addNote({ noteType: 'gotcha', content: 'Persisted', filePath: 'test.ts' });
      service.dispose();

      const filePath = path.join(tmpDir, 'test-project.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as KnowledgeNoteStore;
      expect(store.totalNotes).toBe(1);
    });
  });
});
