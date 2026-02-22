import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { readNotes } from './notes';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
  },
}));

const mockStore = {
  schemaVersion: 1,
  notesByFile: {
    'src/main.ts': [
      { id: 'n1', title: 'Watch out for race condition', content: 'Use mutex', noteType: 'gotcha', importance: 'critical', status: 'active', filePath: 'src/main.ts', source: 'auto_recovery', sessionId: 'abc', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastReviewedAt: '2025-01-01T00:00:00Z' },
      { id: 'n2', title: 'Pattern for error handling', content: 'Try/catch with logging', noteType: 'pattern', importance: 'medium', status: 'active', filePath: 'src/main.ts', source: 'manual', sessionId: 'abc', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastReviewedAt: '2025-01-01T00:00:00Z' },
    ],
    'src/utils.ts': [
      { id: 'n3', title: 'Stale note', content: 'Old info', noteType: 'tip', importance: 'low', status: 'stale', filePath: 'src/utils.ts', source: 'manual', sessionId: 'def', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastReviewedAt: '2025-01-01T00:00:00Z' },
    ],
  },
  lastSaved: '2025-01-01T00:00:00Z',
  totalNotes: 3,
};

beforeEach(() => {
  vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockStore));
});

describe('readNotes', () => {
  it('returns all notes when no filters', async () => {
    const notes = await readNotes('test-slug');
    expect(notes).toHaveLength(3);
  });

  it('filters by file path', async () => {
    const notes = await readNotes('test-slug', { file: 'src/main.ts' });
    expect(notes).toHaveLength(2);
  });

  it('filters by note type', async () => {
    const notes = await readNotes('test-slug', { type: 'gotcha' });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Watch out for race condition');
  });

  it('filters by status', async () => {
    const notes = await readNotes('test-slug', { status: 'stale' });
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('n3');
  });

  it('sorts by importance then updatedAt', async () => {
    const notes = await readNotes('test-slug');
    expect(notes[0].importance).toBe('critical');
  });

  it('returns empty when file missing', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    expect(await readNotes('x')).toEqual([]);
  });
});
