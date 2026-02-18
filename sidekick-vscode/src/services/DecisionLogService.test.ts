/**
 * @fileoverview Tests for DecisionLogService.
 *
 * Tests persistence round-trip, deduplication, search, clear, and error handling.
 *
 * @module DecisionLogService.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DecisionLogService } from './DecisionLogService';
import type { DecisionEntry, DecisionLogStore } from '../types/decisionLog';
import { DECISION_LOG_SCHEMA_VERSION } from '../types/decisionLog';

// Mock vscode module
vi.mock('vscode', () => ({
  Disposable: { from: vi.fn() },
}));

// Mock Logger
vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

function makeEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
    description: 'Use pnpm instead of npm',
    rationale: 'npm install failed due to lockfile conflicts',
    chosenOption: 'pnpm',
    source: 'recovery_pattern',
    sessionId: 'session-123',
    timestamp: '2026-02-18T10:00:00.000Z',
    ...overrides,
  };
}

let tmpDir: string;

function createService(slug = 'test-project'): DecisionLogService {
  const service = new DecisionLogService(slug);
  const dataFilePath = path.join(tmpDir, `${slug}.json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).dataFilePath = dataFilePath;
  return service;
}

describe('DecisionLogService', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-decision-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates empty store when no file exists', async () => {
      const service = createService();
      await service.initialize();

      const entries = service.getEntries();
      expect(entries).toEqual([]);
    });

    it('loads existing store from disk', async () => {
      const store: DecisionLogStore = {
        schemaVersion: DECISION_LOG_SCHEMA_VERSION,
        decisions: {
          'd1': makeEntry({ id: 'd1', description: 'Use vitest' }),
        },
        lastSessionId: 'session-abc',
        lastSaved: '2026-02-18T10:06:00.000Z',
      };

      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        JSON.stringify(store)
      );

      const service = createService();
      await service.initialize();

      const entries = service.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('Use vitest');
    });

    it('falls back to empty store on corrupt JSON', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'test-project.json'),
        'not valid json{{{'
      );

      const service = createService();
      await service.initialize();

      const entries = service.getEntries();
      expect(entries).toEqual([]);
    });
  });

  describe('addEntries', () => {
    it('adds entries and persists via round-trip', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Decision A' }),
        makeEntry({ id: 'd2', description: 'Decision B' }),
      ]);
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      const entries = service2.getEntries();

      expect(entries).toHaveLength(2);
      service2.dispose();
    });

    it('deduplicates entries with same description+source', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Use pnpm', source: 'recovery_pattern' }),
      ]);

      // Add duplicate
      service.addEntries([
        makeEntry({ id: 'd2', description: 'Use pnpm', source: 'recovery_pattern' }),
      ]);

      expect(service.getEntryCount()).toBe(1);
      service.dispose();
    });

    it('allows same description with different source', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Use pnpm', source: 'recovery_pattern' }),
        makeEntry({ id: 'd2', description: 'Use pnpm', source: 'text_pattern' }),
      ]);

      expect(service.getEntryCount()).toBe(2);
      service.dispose();
    });
  });

  describe('getEntries', () => {
    it('returns entries sorted by timestamp descending', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Older', timestamp: '2026-02-18T08:00:00Z' }),
        makeEntry({ id: 'd2', description: 'Newer', timestamp: '2026-02-18T12:00:00Z' }),
        makeEntry({ id: 'd3', description: 'Middle', timestamp: '2026-02-18T10:00:00Z' }),
      ]);

      const entries = service.getEntries();
      expect(entries.map(e => e.description)).toEqual(['Newer', 'Middle', 'Older']);
      service.dispose();
    });

    it('filters by search query (case-insensitive)', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Use pnpm for package management', chosenOption: 'pnpm' }),
        makeEntry({ id: 'd2', description: 'Use vitest for testing', chosenOption: 'vitest', rationale: 'Fast test runner' }),
        makeEntry({ id: 'd3', description: 'Use TypeScript', chosenOption: 'TypeScript', rationale: 'Better pnpm compat' }),
      ]);

      const results = service.getEntries('pnpm');
      expect(results).toHaveLength(2);
      service.dispose();
    });

    it('searches across description, rationale, and chosenOption', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1', description: 'Database choice', chosenOption: 'PostgreSQL' }),
        makeEntry({ id: 'd2', description: 'ORM choice', rationale: 'PostgreSQL works well with Prisma' }),
      ]);

      const results = service.getEntries('postgresql');
      expect(results).toHaveLength(2);
      service.dispose();
    });

    it('returns all entries for empty query', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1' }),
        makeEntry({ id: 'd2', description: 'Another decision' }),
      ]);

      expect(service.getEntries('')).toHaveLength(2);
      expect(service.getEntries()).toHaveLength(2);
      service.dispose();
    });
  });

  describe('clearAll', () => {
    it('removes all decisions', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([
        makeEntry({ id: 'd1' }),
        makeEntry({ id: 'd2', description: 'Another' }),
      ]);

      service.clearAll();
      service.dispose();

      const service2 = createService();
      await service2.initialize();
      expect(service2.getEntries()).toHaveLength(0);
      service2.dispose();
    });
  });

  describe('dispose', () => {
    it('writes dirty data synchronously on dispose', async () => {
      const service = createService();
      await service.initialize();

      service.addEntries([makeEntry({ id: 'd1' })]);
      service.dispose();

      const filePath = path.join(tmpDir, 'test-project.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DecisionLogStore;
      expect(Object.keys(store.decisions)).toHaveLength(1);
    });

    it('does not write when not dirty', async () => {
      const service = createService();
      await service.initialize();
      service.dispose();

      const filePath = path.join(tmpDir, 'test-project.json');
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('getEntryCount', () => {
    it('returns correct count', async () => {
      const service = createService();
      await service.initialize();

      expect(service.getEntryCount()).toBe(0);

      service.addEntries([
        makeEntry({ id: 'd1' }),
        makeEntry({ id: 'd2', description: 'Another' }),
      ]);

      expect(service.getEntryCount()).toBe(2);
      service.dispose();
    });
  });
});
