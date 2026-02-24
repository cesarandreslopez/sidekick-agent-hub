import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { readPlans, getLatestPlan } from './plans';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

const mockStore = {
  schemaVersion: 1,
  plans: [
    {
      id: 'abc-1',
      projectSlug: 'test',
      sessionId: 'session-1',
      title: 'Build Auth',
      source: 'claude-code',
      createdAt: '2025-01-03T00:00:00Z',
      status: 'completed',
      steps: [
        { id: 'step-0', description: 'Set up DB', status: 'completed' },
        { id: 'step-1', description: 'Add middleware', status: 'completed' },
      ],
      completionRate: 1.0,
      totalDurationMs: 120000,
    },
    {
      id: 'def-2',
      projectSlug: 'test',
      sessionId: 'session-2',
      title: 'Add Tests',
      source: 'opencode',
      createdAt: '2025-01-02T00:00:00Z',
      status: 'failed',
      steps: [
        { id: 'step-0', description: 'Write unit tests', status: 'completed' },
        { id: 'step-1', description: 'Write e2e tests', status: 'failed', errorMessage: 'timeout' },
      ],
      completionRate: 0.5,
    },
    {
      id: 'ghi-3',
      projectSlug: 'test',
      sessionId: 'session-3',
      title: 'Refactor API',
      source: 'codex',
      createdAt: '2025-01-01T00:00:00Z',
      status: 'abandoned',
      steps: [
        { id: 'step-0', description: 'Extract routes', status: 'skipped' },
      ],
      completionRate: 0,
    },
  ],
  lastSaved: '2025-01-03T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockStore));
});

describe('readPlans', () => {
  it('returns all plans by default', async () => {
    const plans = await readPlans('test-slug');
    expect(plans).toHaveLength(3);
  });

  it('filters by completed status', async () => {
    const plans = await readPlans('test-slug', { status: 'completed' });
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Build Auth');
  });

  it('filters by failed status', async () => {
    const plans = await readPlans('test-slug', { status: 'failed' });
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Add Tests');
  });

  it('filters by source', async () => {
    const plans = await readPlans('test-slug', { source: 'codex' });
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Refactor API');
  });

  it('respects limit', async () => {
    const plans = await readPlans('test-slug', { limit: 2 });
    expect(plans).toHaveLength(2);
  });

  it('returns empty array when file does not exist', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    const plans = await readPlans('nonexistent');
    expect(plans).toEqual([]);
  });
});

describe('getLatestPlan', () => {
  it('returns the most recent plan', async () => {
    const plan = await getLatestPlan('test-slug');
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('Build Auth');
  });

  it('returns null when no plans exist', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    const plan = await getLatestPlan('nonexistent');
    expect(plan).toBeNull();
  });
});
