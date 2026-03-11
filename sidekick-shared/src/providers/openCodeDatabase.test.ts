import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExistsSync = vi.fn<(path: unknown) => boolean>().mockReturnValue(true);
const mockExecFileSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (input: unknown) => mockExistsSync(input),
  };
});

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { OpenCodeDatabase } from './openCodeDatabase';

describe('OpenCodeDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('reports sqlite_missing when sqlite3 is not executable', () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' });
    });

    const db = new OpenCodeDatabase('/tmp/opencode');

    expect(db.open()).toBe(false);
    expect(db.getRuntimeStatus()).toEqual({
      available: false,
      kind: 'sqlite_missing',
      message: 'sqlite3 executable not found in PATH.',
    });
  });

  it('matches projects by worktree sandboxes and session directories', () => {
    mockExecFileSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === '--version') {
        return '3.51.0';
      }

      const sql = args[3] || '';
      if (sql.includes('SELECT id FROM project WHERE id =')) {
        return sql.includes("'proj_1'") ? JSON.stringify([{ id: 'proj_1' }]) : '[]';
      }

      if (sql.includes('FROM project')) {
        return JSON.stringify([
          {
            id: 'proj_1',
            worktree: '/repo',
            name: 'Repo',
            sandboxes: JSON.stringify(['/repo-worktree']),
            time_created: 1,
            time_updated: 2,
          },
        ]);
      }

      if (sql.includes('FROM session WHERE parent_id IS NULL')) {
        return JSON.stringify([
          {
            id: 'ses_1',
            project_id: 'proj_1',
            title: 'Session',
            directory: '/repo-sandbox/current',
            time_created: 1,
            time_updated: 2,
          },
        ]);
      }

      return '[]';
    });

    const db = new OpenCodeDatabase('/tmp/opencode');

    expect(db.open()).toBe(true);
    expect(db.findProjectByWorktree('/repo-worktree/src')?.id).toBe('proj_1');
    expect(db.findProjectBySessionDirectory('/repo-sandbox/current/app')?.id).toBe('proj_1');
    expect(db.hasProject('proj_1')).toBe(true);
    expect(db.hasProject('missing')).toBe(false);
  });
});
