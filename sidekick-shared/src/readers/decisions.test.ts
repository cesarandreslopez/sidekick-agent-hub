import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { readDecisions } from './decisions';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
  },
}));

const mockStore = {
  schemaVersion: 1,
  decisions: {
    'd1': { id: 'd1', description: 'Use esbuild for bundling', rationale: 'Fast and simple', chosenOption: 'esbuild', source: 'plan_mode' as const, sessionId: 'abc', timestamp: '2025-01-01T00:00:00Z' },
    'd2': { id: 'd2', description: 'Use Vitest for testing', rationale: 'Compatible with TypeScript', chosenOption: 'vitest', source: 'user_question' as const, sessionId: 'abc', timestamp: '2025-01-02T00:00:00Z' },
    'd3': { id: 'd3', description: 'Adopt strict TypeScript', rationale: 'Catch errors early', chosenOption: 'strict: true', source: 'text_pattern' as const, sessionId: 'def', timestamp: '2025-01-03T00:00:00Z' },
  },
  lastSessionId: 'def',
  lastSaved: '2025-01-03T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockStore));
});

describe('readDecisions', () => {
  it('returns all decisions sorted by timestamp desc', async () => {
    const decisions = await readDecisions('test-slug');
    expect(decisions).toHaveLength(3);
    expect(decisions[0].id).toBe('d3');
  });

  it('filters by search query', async () => {
    const decisions = await readDecisions('test-slug', { search: 'esbuild' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe('d1');
  });

  it('limits results', async () => {
    const decisions = await readDecisions('test-slug', { limit: 2 });
    expect(decisions).toHaveLength(2);
  });

  it('returns empty when file missing', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    expect(await readDecisions('x')).toEqual([]);
  });
});
