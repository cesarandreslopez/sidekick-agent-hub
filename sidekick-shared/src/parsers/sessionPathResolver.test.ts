import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', vanishingBasename: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mocks.home };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: (filePath: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (path.basename(String(filePath)) === mocks.vanishingBasename) {
        const error = new Error('vanished') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return actual.statSync(filePath, options as never);
    },
  };
});

import { findAllSessions, getSessionDirectory } from './sessionPathResolver';

afterEach(() => {
  if (mocks.home) fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
  mocks.vanishingBasename = '';
});

describe('findAllSessions', () => {
  it('keeps readable sessions when another file vanishes during stat', () => {
    mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-paths-'));
    const workspace = '/workspace/project';
    const sessionDir = getSessionDirectory(workspace);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'readable.jsonl'), '{}\n');
    fs.writeFileSync(path.join(sessionDir, 'vanished.jsonl'), '{}\n');
    mocks.vanishingBasename = 'vanished.jsonl';

    expect(findAllSessions(workspace)).toEqual([path.join(sessionDir, 'readable.jsonl')]);
  });
});
