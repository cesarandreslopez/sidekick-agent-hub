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

import {
  decodeEncodedPath,
  encodeWorkspacePath,
  findAllSessions,
  getSessionDirectory,
} from './sessionPathResolver';

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

describe('encodeWorkspacePath', () => {
  // Pins Claude Code's real on-disk naming under ~/.claude/projects/, verified
  // against live installs: every non-ASCII-alphanumeric character becomes a
  // hyphen (dots and underscores included), case is preserved.

  it('encodes a Unix path with a leading hyphen', () => {
    expect(encodeWorkspacePath('/home/user/code/project')).toBe('-home-user-code-project');
  });

  it('preserves case in macOS-style paths', () => {
    expect(encodeWorkspacePath('/Users/user/code/project')).toBe('-Users-user-code-project');
  });

  it('encodes a Windows drive letter with a double hyphen', () => {
    expect(encodeWorkspacePath('C:\\Users\\user\\code\\project')).toBe(
      'C--Users-user-code-project',
    );
    expect(encodeWorkspacePath('C:/Users/user/code/project')).toBe('C--Users-user-code-project');
  });

  it('replaces underscores', () => {
    expect(encodeWorkspacePath('/home/user/my_project_name')).toBe('-home-user-my-project-name');
    expect(
      encodeWorkspacePath('C:\\Users\\andre\\OneDrive\\Documents\\humans_are_awesome_epub'),
    ).toBe('C--Users-andre-OneDrive-Documents-humans-are-awesome-epub');
  });

  it('replaces dots and spaces the same way Claude Code does', () => {
    expect(encodeWorkspacePath('/home/user/my project/app.v2')).toBe(
      '-home-user-my-project-app-v2',
    );
  });

  it('produces double hyphens for dot-prefixed segments (worktree layout)', () => {
    expect(encodeWorkspacePath('/a/.claude-worktrees/x')).toBe('-a--claude-worktrees-x');
  });

  it('handles the root path', () => {
    expect(encodeWorkspacePath('/')).toBe('-');
  });

  it('round-trips through the lossy decoder', () => {
    // decodeEncodedPath is documented as lossy (every hyphen becomes a slash);
    // it only inverts paths whose segments contained no replaced characters.
    expect(decodeEncodedPath(encodeWorkspacePath('/home/user/code/project'))).toBe(
      '/home/user/code/project',
    );
  });
});
