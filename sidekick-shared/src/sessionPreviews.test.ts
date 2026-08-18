import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionProviderBase } from './providers/types';
import { listSessionPreviews, readSessionPreview } from './sessionPreviews';

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-previews-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeProviderHandle {
  provider: SessionProviderBase;
  labelCalls: string[];
}

function makeFakeProvider(
  id: 'claude-code' | 'codex',
  files: string[],
  overrides: Record<string, unknown> = {},
): FakeProviderHandle {
  const labelCalls: string[] = [];
  const provider = {
    id,
    displayName: `fake-${id}`,
    extractSessionLabel: (sessionPath: string) => {
      labelCalls.push(sessionPath);
      return `prompt for ${path.basename(sessionPath)}`;
    },
    getSessionId: (sessionPath: string) => path.basename(sessionPath, '.jsonl'),
    findAllSessions: () => files,
    listAllSessionFiles: () =>
      files.map((filePath) => ({ path: filePath, mtime: fs.statSync(filePath).mtime })),
    ...overrides,
  } as unknown as SessionProviderBase;
  return { provider, labelCalls };
}

function writeSession(dir: string, name: string, lines: string[], mtime?: Date): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

describe('readSessionPreview', () => {
  it('extracts timestamp and cwd from a Claude-style prefix', () => {
    const dir = makeTempDir();
    const filePath = writeSession(dir, 'session-1.jsonl', [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-18T10:00:00.000Z',
        cwd: '/workspace/project',
        message: { role: 'user', content: 'hello' },
      }),
    ]);
    const { provider } = makeFakeProvider('claude-code', [filePath]);

    const preview = readSessionPreview(provider, filePath);

    expect(preview).toMatchObject({
      provider: 'claude-code',
      sessionId: 'session-1',
      filePath,
      firstUserPrompt: 'prompt for session-1.jsonl',
      firstTimestamp: '2026-08-18T10:00:00.000Z',
      workspacePath: '/workspace/project',
    });
    expect(preview!.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(preview!.modifiedAt)).not.toBeNaN();
  });

  it('extracts cwd from a Codex session_meta payload', () => {
    const dir = makeTempDir();
    const filePath = writeSession(dir, 'rollout-x.jsonl', [
      JSON.stringify({
        timestamp: '2026-08-18T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'abc', cwd: '/workspace/codex-project' },
      }),
    ]);
    const { provider } = makeFakeProvider('codex', [filePath]);

    const preview = readSessionPreview(provider, filePath);

    expect(preview).toMatchObject({
      firstTimestamp: '2026-08-18T11:00:00.000Z',
      workspacePath: '/workspace/codex-project',
    });
  });

  it('returns null for a missing file', () => {
    const dir = makeTempDir();
    const { provider } = makeFakeProvider('claude-code', []);

    expect(readSessionPreview(provider, path.join(dir, 'absent.jsonl'))).toBeNull();
  });

  it('degrades to null fields on malformed content instead of throwing', () => {
    const dir = makeTempDir();
    const binary = path.join(dir, 'binary.jsonl');
    fs.writeFileSync(binary, Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x82]));
    const truncated = writeSession(dir, 'truncated.jsonl', ['{"timestamp": "2026-']);
    const empty = writeSession(dir, 'empty.jsonl', ['']);
    const { provider } = makeFakeProvider('claude-code', [binary, truncated, empty]);

    for (const filePath of [binary, truncated, empty]) {
      const preview = readSessionPreview(provider, filePath);
      expect(preview).not.toBeNull();
      expect(preview!.firstTimestamp).toBeNull();
      expect(preview!.workspacePath).toBeNull();
    }
  });

  it('ignores a line that straddles the prefix budget', () => {
    const dir = makeTempDir();
    // One huge event first: its line does not complete within the budget, so
    // the scan must treat it as partial rather than parse garbage.
    const filePath = writeSession(dir, 'big-first-event.jsonl', [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-18T09:00:00.000Z',
        blob: 'x'.repeat(4096),
      }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-18T09:01:00.000Z' }),
    ]);
    const { provider } = makeFakeProvider('claude-code', [filePath]);

    const preview = readSessionPreview(provider, filePath, { maxPrefixBytes: 256 });

    expect(preview!.firstTimestamp).toBeNull();
  });
});

describe('listSessionPreviews', () => {
  it('merges providers newest first', () => {
    const dir = makeTempDir();
    const older = writeSession(dir, 'claude-old.jsonl', ['{}'], new Date(Date.now() - 60_000));
    const newest = writeSession(dir, 'rollout-new.jsonl', ['{}'], new Date());
    const middle = writeSession(dir, 'claude-mid.jsonl', ['{}'], new Date(Date.now() - 30_000));
    const claude = makeFakeProvider('claude-code', [older, middle]);
    const codex = makeFakeProvider('codex', [newest]);

    const previews = listSessionPreviews([claude.provider, codex.provider]);

    expect(previews.map((preview) => preview.filePath)).toEqual([newest, middle, older]);
    expect(previews.map((preview) => preview.provider)).toEqual([
      'codex',
      'claude-code',
      'claude-code',
    ]);
  });

  it('reads content only for the returned slice', () => {
    const dir = makeTempDir();
    const files = Array.from({ length: 6 }, (_, index) =>
      writeSession(dir, `session-${index}.jsonl`, ['{}'], new Date(Date.now() - index * 10_000)),
    );
    const { provider, labelCalls } = makeFakeProvider('claude-code', files);

    const previews = listSessionPreviews([provider], { limit: 2 });

    expect(previews).toHaveLength(2);
    // The whole point of the module: enumeration is stat-only, so the four
    // sessions beyond the limit are never opened for label extraction.
    expect(labelCalls).toHaveLength(2);
  });

  it('applies the since cutoff during enumeration', () => {
    const dir = makeTempDir();
    const old = writeSession(dir, 'old.jsonl', ['{}'], new Date(Date.now() - 120_000));
    const fresh = writeSession(dir, 'fresh.jsonl', ['{}'], new Date());
    const { provider, labelCalls } = makeFakeProvider('claude-code', [old, fresh]);

    const previews = listSessionPreviews([provider], { since: new Date(Date.now() - 60_000) });

    expect(previews.map((preview) => preview.filePath)).toEqual([fresh]);
    expect(labelCalls).toEqual([fresh]);
  });

  it('scopes to a workspace via findAllSessions', () => {
    const dir = makeTempDir();
    const inWorkspace = writeSession(dir, 'in-workspace.jsonl', ['{}']);
    const elsewhere = writeSession(dir, 'elsewhere.jsonl', ['{}']);
    const { provider } = makeFakeProvider('claude-code', [inWorkspace, elsewhere], {
      findAllSessions: (workspacePath: string) =>
        workspacePath === '/workspace/scoped' ? [inWorkspace] : [],
    });

    const previews = listSessionPreviews([provider], { workspacePath: '/workspace/scoped' });

    expect(previews.map((preview) => preview.filePath)).toEqual([inWorkspace]);
  });

  it('falls back to project-folder enumeration when listAllSessionFiles is absent', () => {
    const dir = makeTempDir();
    const filePath = writeSession(dir, 'folder-session.jsonl', ['{}']);
    const { provider } = makeFakeProvider('claude-code', [filePath], {
      listAllSessionFiles: undefined,
      getAllProjectFolders: () => [
        { dir, name: 'project', encodedName: 'project', sessionCount: 1, lastModified: new Date() },
      ],
      findSessionsInDirectory: (folderDir: string) =>
        folderDir === dir ? [filePath, filePath] : [],
    });

    const previews = listSessionPreviews([provider]);

    expect(previews.map((preview) => preview.filePath)).toEqual([filePath]);
  });

  it('skips files that vanish between enumeration and preview', () => {
    const dir = makeTempDir();
    const stays = writeSession(dir, 'stays.jsonl', ['{}']);
    const vanished = path.join(dir, 'vanished.jsonl');
    const { provider } = makeFakeProvider('claude-code', [stays], {
      listAllSessionFiles: () => [
        { path: stays, mtime: fs.statSync(stays).mtime },
        { path: vanished, mtime: new Date() },
      ],
    });

    const previews = listSessionPreviews([provider]);

    expect(previews.map((preview) => preview.filePath)).toEqual([stays]);
  });
});
