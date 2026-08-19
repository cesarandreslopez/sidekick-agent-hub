import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let home: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => home };
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => home };
});

import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';

describe('provider-neutral findSessionById', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-provider-lookup-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('uses Claude session filenames and returns null for wrong ids', () => {
    const workspace = '/workspace/project';
    const provider = new ClaudeCodeProvider();
    const sessionPath = path.join(provider.getSessionDirectory(workspace), 'session-one.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{not-read-by-lookup}\n');

    expect(provider.findSessionById(workspace, 'session-one')).toBe(sessionPath);
    expect(provider.findSessionById(workspace, 'missing')).toBeNull();
    expect(provider.findSessionById(workspace, '../escape')).toBeNull();
  });

  it('uses Codex rollout filenames and returns null for wrong ids', () => {
    const id = '019d86b0-b20c-7b02-a3b2-efe5c1ed7122';
    const sessionPath = path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '08',
      '18',
      `rollout-2026-08-18-${id}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{not-read-by-lookup}\n');
    const provider = new CodexProvider();

    expect(provider.findSessionById('/workspace/project', id)).toBe(sessionPath);
    expect(provider.findSessionById('/workspace/project', 'missing')).toBeNull();
  });
});
