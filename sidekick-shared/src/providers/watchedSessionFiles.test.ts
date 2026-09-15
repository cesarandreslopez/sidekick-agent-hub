import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';

function ageDirectory(dir: string): void {
  const when = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(dir, when, when);
}

describe('ClaudeCodeProvider.statWatchedSessionFile', () => {
  let home: string;
  let previousHome: string | undefined;
  let root: string;
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-claude-watch-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    root = path.join(home, '.claude', 'projects');
    fs.mkdirSync(path.join(root, '-Users-me-proj'), { recursive: true });
    fs.mkdirSync(path.join(root, '-Users-me-other'), { recursive: true });
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    provider.dispose();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves a session file, reports empty or vanished ones as missing', async () => {
    const sessionPath = path.join(root, '-Users-me-proj', 'abc.jsonl');
    fs.writeFileSync(sessionPath, '');
    expect(await provider.statWatchedSessionFile(root, '-Users-me-proj/abc.jsonl')).toEqual({
      status: 'missing',
      path: sessionPath,
      sessionId: 'abc',
    });
    fs.appendFileSync(sessionPath, '{"type":"user"}\n');
    const present = await provider.statWatchedSessionFile(root, '-Users-me-proj/abc.jsonl');
    expect(present).toMatchObject({
      status: 'present',
      file: { path: sessionPath, sessionId: 'abc', sizeBytes: 16 },
    });
    fs.rmSync(sessionPath);
    expect(await provider.statWatchedSessionFile(root, '-Users-me-proj/abc.jsonl')).toMatchObject({
      status: 'missing',
    });
  });

  it('ignores subagent transcripts, non-session files, and other workspaces', async () => {
    expect(
      await provider.statWatchedSessionFile(root, '-Users-me-proj/abc/subagents/agent-1.jsonl'),
    ).toEqual({ status: 'ignored' });
    expect(await provider.statWatchedSessionFile(root, '-Users-me-proj/abc')).toEqual({
      status: 'ignored',
    });
    fs.writeFileSync(path.join(root, '-Users-me-other', 'zzz.jsonl'), '{}\n');
    expect(
      await provider.statWatchedSessionFile(root, '-Users-me-other/zzz.jsonl', '/Users/me/proj'),
    ).toEqual({ status: 'ignored' });
    expect(
      await provider.statWatchedSessionFile(root, '-Users-me-other/zzz.jsonl', '/Users/me/other'),
    ).toMatchObject({ status: 'present' });
  });

  it('treats a project directory appearing or vanishing as unknown', async () => {
    expect(await provider.statWatchedSessionFile(root, '-Users-me-proj')).toEqual({
      status: 'unknown',
    });
    expect(await provider.statWatchedSessionFile(root, '-Users-me-gone')).toEqual({
      status: 'unknown',
    });
    fs.writeFileSync(path.join(root, '.DS_Store'), '');
    expect(await provider.statWatchedSessionFile(root, '.DS_Store')).toEqual({ status: 'ignored' });
    expect(await provider.statWatchedSessionFile(root, '')).toEqual({ status: 'unknown' });
  });

  it('listSessionFilesAsync with limit visits newest directories first and stops early', async () => {
    const older = path.join(root, '-Users-me-other');
    const newer = path.join(root, '-Users-me-proj');
    const oldWhen = new Date(Date.now() - 3 * 60 * 60_000);
    const newWhen = new Date(Date.now() - 2 * 60 * 60_000);
    for (const [dir, when, names] of [
      [older, oldWhen, ['o1.jsonl', 'o2.jsonl']],
      [newer, newWhen, ['n1.jsonl', 'n2.jsonl']],
    ] as const) {
      for (const name of names) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '{}\n');
        fs.utimesSync(file, when, when);
      }
      fs.utimesSync(dir, when, when);
    }
    ageDirectory(root);
    const stats = {};
    const files = await provider.listSessionFilesAsync(undefined, { limit: 2, stats });
    expect(files.map((file) => file.sessionId).sort()).toEqual(['n1', 'n2']);
    // The root and the newest directory were listed; the older one was only stat'ed.
    expect(stats).toMatchObject({ directoriesListed: 2, filesStatted: 2 });

    const since = await provider.listSessionFilesAsync(undefined, {
      since: newWhen.getTime() - 1,
    });
    expect(since.map((file) => file.sessionId).sort()).toEqual(['n1', 'n2']);
    const all = await provider.listSessionFilesAsync();
    expect(all).toHaveLength(4);
  });
});

describe('CodexProvider.statWatchedSessionFile', () => {
  let root: string;
  let provider: CodexProvider;
  const id = '019d86b0-b20c-7b02-a3b2-000000000001';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-watch-'));
    fs.mkdirSync(path.join(root, '2026', '09', '05'), { recursive: true });
    provider = new CodexProvider();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves rollouts by name and does not cache a cwd before session_meta is complete', async () => {
    const relative = path.join('2026', '09', '05', `rollout-20260905-${id}.jsonl`);
    const rollout = path.join(root, relative);
    fs.writeFileSync(rollout, '{"type":"session_meta","payload":{"cwd":"/ws/app"');
    // Incomplete first line: the session exists but its workspace is unknown yet.
    expect(await provider.statWatchedSessionFile(root, relative, '/ws/app')).toEqual({
      status: 'ignored',
    });
    expect(await provider.statWatchedSessionFile(root, relative)).toMatchObject({
      status: 'present',
      file: { path: rollout, sessionId: id },
    });

    fs.appendFileSync(rollout, '}}\n');
    expect(await provider.statWatchedSessionFile(root, relative, '/ws/app')).toMatchObject({
      status: 'present',
      file: { workspacePath: '/ws/app' },
    });
    expect(await provider.statWatchedSessionFile(root, relative, '/elsewhere')).toEqual({
      status: 'ignored',
    });
  });

  it('classifies directories as unknown and foreign files as ignored', async () => {
    expect(await provider.statWatchedSessionFile(root, path.join('2026', '09', '06'))).toEqual({
      status: 'unknown',
    });
    fs.writeFileSync(path.join(root, '2026', '09', '05', 'notes.txt'), 'x');
    expect(
      await provider.statWatchedSessionFile(root, path.join('2026', '09', '05', 'notes.txt')),
    ).toEqual({ status: 'ignored' });
    expect(await provider.statWatchedSessionFile(root, 'a/b/c/d/e/f/g/h/rollout-x.jsonl')).toEqual({
      status: 'ignored',
    });
    expect(
      await provider.statWatchedSessionFile(
        root,
        path.join('2026', '09', '05', 'rollout-gone-' + id + '.jsonl'),
      ),
    ).toMatchObject({ status: 'missing', sessionId: id });
  });
});
