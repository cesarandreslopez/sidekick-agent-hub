import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

// No Codex state database: rollouts are listed from the sessions directory.
vi.mock('./codexDatabase', async () => {
  const actual = await vi.importActual<typeof import('./codexDatabase')>('./codexDatabase');
  return {
    ...actual,
    CodexDatabase: class {
      isAvailable(): boolean {
        return false;
      }
      open(): boolean {
        return false;
      }
      getRuntimeStatus() {
        return { available: false, kind: 'db_missing' as const };
      }
      async getThreadsByIdsAsync(): Promise<never[]> {
        return [];
      }
      close(): void {}
    },
  };
});

import { collectPromptHistory } from '../promptHistory';
import { collectSessionPromptHistory } from '../sessionPromptHistory';
import { findToolCallOrigins } from '../toolCallOrigins';
import { collectUsageEvents } from '../usage/usageEvents';
import { ts, writeJsonl, type Row } from '../testing/sessionLogFixtures';
import type { SessionProviderDiagnostic } from './types';
import { CodexProvider } from './codex';
import { createSessionProviders } from './factory';
import {
  __compressedRolloutTesting,
  canReadCompressedRollouts,
  isCompressedRolloutPath,
  openRolloutReadHandle,
  readRolloutFirstLines,
  readRolloutHead,
  readRolloutText,
  resetCompressedRolloutDiagnostics,
  resolveRolloutPath,
  statRolloutContent,
  zstdFrameContentSize,
} from './compressedRollouts';
import {
  extractRolloutSessionId,
  isCompressedRolloutFile,
  walkRolloutFiles,
  walkRolloutFilesAsync,
} from './rolloutWalker';
import { DirectoryListingCache } from './directoryListingCache';

type Compress = (input: Buffer) => Buffer;
const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: Compress }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';
const MODEL = 'gpt-5-codex';
const SESSION_ID = '019d86b0-b20c-7b02-a3b2-0000000000a1';

let repo: string;
let sessionsDir: string;
let savedCodexHome: string | undefined;

function rolloutFile(id = SESSION_ID, day = '01'): string {
  return path.join(sessionsDir, '2026', '09', day, `rollout-2026-09-${day}T10-00-00-${id}.jsonl`);
}

/** Replaces `file` by its compressed copy, keeping its mtime, as Codex does. */
function compress(file: string, keepPlain = false): string {
  const compressed = `${file}.zst`;
  fs.writeFileSync(compressed, zstdCompressSync!(fs.readFileSync(file)));
  const { mtime } = fs.statSync(file);
  fs.utimesSync(compressed, mtime, mtime);
  if (!keepPlain) fs.rmSync(file);
  return compressed;
}

function interactiveRows(id = SESSION_ID): Row[] {
  const call = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
  return [
    {
      timestamp: ts(0),
      type: 'session_meta',
      payload: { id, timestamp: ts(0), cwd: repo, originator: 'codex-tui', source: 'cli' },
    },
    { timestamp: ts(1), type: 'turn_context', payload: { model: MODEL, cwd: repo } },
    {
      timestamp: ts(2),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first compressed prompt' }],
      },
    },
    {
      timestamp: ts(3),
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_zst_exec',
        name: 'exec_command',
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      timestamp: ts(4),
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: call, total_token_usage: call } },
    },
    {
      timestamp: ts(5),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'second compressed prompt' }],
      },
    },
  ];
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-zst-')));
  repo = path.join(tmpDir, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
  sessionsDir = path.join(tmpDir, '.codex', 'sessions');
  resetCompressedRolloutDiagnostics();
});

afterEach(() => {
  __compressedRolloutTesting.setDecompress(undefined);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('compressed rollout reads', () => {
  it('names compressed rollouts and their session ids', () => {
    const name = `rollout-2026-09-01T10-00-00-${SESSION_ID}.jsonl.zst`;
    expect(isCompressedRolloutPath(`/x/${name}`)).toBe(true);
    expect(isCompressedRolloutFile(name)).toBe(true);
    expect(isCompressedRolloutFile(name.slice(0, -4))).toBe(false);
    expect(extractRolloutSessionId(name)).toBe(SESSION_ID);
    expect(extractRolloutSessionId(name.slice(0, -4))).toBe(SESSION_ID);
  });

  it.skipIf(!hasZstd)('decompresses whole files, prefixes, and first lines', async () => {
    const file = rolloutFile();
    writeJsonl(file, [
      ...interactiveRows(),
      { timestamp: ts(9), type: 'event_msg', payload: { type: 'x', blob: 'y'.repeat(300_000) } },
    ]);
    const plain = fs.readFileSync(file, 'utf8');
    const compressed = compress(file, true);

    expect(readRolloutText(compressed)).toBe(plain);
    expect(readRolloutText(file)).toBe(plain);
    expect(readRolloutHead(compressed, 100).toString('utf8')).toBe(plain.slice(0, 100));
    expect(readRolloutFirstLines(compressed, 2)).toEqual(plain.split('\n').slice(0, 2));
    expect(zstdFrameContentSize(fs.readFileSync(compressed).subarray(0, 18))).toBe(
      Buffer.byteLength(plain),
    );
    const stat = await statRolloutContent(compressed);
    expect(stat).toEqual({
      size: Buffer.byteLength(plain),
      mtimeMs: fs.statSync(compressed).mtimeMs,
    });
    const { handle, size } = await openRolloutReadHandle(compressed);
    const buffer = Buffer.alloc(10);
    expect(size).toBe(Buffer.byteLength(plain));
    expect((await handle.read(buffer, 0, 10, 5)).bytesRead).toBe(10);
    expect(buffer.toString('utf8')).toBe(plain.slice(5, 15));
    await handle.close();

    fs.rmSync(file);
    expect(resolveRolloutPath(file)).toBe(null);
    expect(resolveRolloutPath(file, { includeCompressed: true })).toBe(compressed);
  });

  it('skips compressed rollouts, reporting once, when the runtime cannot decompress', () => {
    const file = `${rolloutFile()}.zst`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]));
    __compressedRolloutTesting.setDecompress(null);
    const diagnostics: SessionProviderDiagnostic[] = [];
    const onDiagnostic = (d: SessionProviderDiagnostic) => diagnostics.push(d);

    expect(canReadCompressedRollouts({ onDiagnostic })).toBe(false);
    expect(readRolloutText(file, { onDiagnostic })).toBe(null);
    expect(readRolloutHead(file, 100, { onDiagnostic }).length).toBe(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ providerId: 'codex', kind: 'read_failed', severity: 'info' }),
    ]);
    expect(diagnostics[0].message).toContain('zstdDecompressSync');
  });

  it.skipIf(!hasZstd)('reports a corrupt compressed rollout', () => {
    const file = `${rolloutFile()}.zst`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not zstd at all');
    const diagnostics: SessionProviderDiagnostic[] = [];
    expect(readRolloutText(file, { onDiagnostic: (d) => diagnostics.push(d) })).toBe(null);
    expect(diagnostics).toEqual([expect.objectContaining({ severity: 'warning' })]);
  });
});

describe('compressed rollout discovery', () => {
  it.skipIf(!hasZstd)(
    'walks compressed rollouts only when asked, preferring a plain twin',
    async () => {
      const live = rolloutFile('019d86b0-b20c-7b02-a3b2-0000000000a2', '02');
      const archived = rolloutFile('019d86b0-b20c-7b02-a3b2-0000000000a3', '01');
      const twin = rolloutFile('019d86b0-b20c-7b02-a3b2-0000000000a4', '01');
      for (const file of [live, archived, twin]) writeJsonl(file, interactiveRows());
      const compressedArchived = compress(archived);
      compress(twin, true); // mid-compression: both exist

      const names = (files: { path: string }[]) => files.map((f) => path.basename(f.path)).sort();
      expect(names(walkRolloutFiles([sessionsDir]))).toEqual(
        names([{ path: live }, { path: twin }]),
      );
      const all = names([{ path: live }, { path: twin }, { path: compressedArchived }]);
      expect(names(walkRolloutFiles([sessionsDir], { includeCompressed: true }))).toEqual(all);
      expect(
        names(await walkRolloutFilesAsync([sessionsDir], { includeCompressed: true })),
      ).toEqual(all);
      const cache = new DirectoryListingCache();
      expect(
        names(await walkRolloutFilesAsync([sessionsDir], { includeCompressed: true, cache })),
      ).toEqual(all);
      // A cached listing never leaks compressed files into a plain walk.
      expect(names(await walkRolloutFilesAsync([sessionsDir], { cache }))).toEqual(
        names([{ path: live }, { path: twin }]),
      );
    },
  );

  it.skipIf(!hasZstd)('lists, labels, finds, searches, and reads compressed sessions', async () => {
    const file = rolloutFile();
    writeJsonl(file, interactiveRows());
    const plainEvents = new CodexProvider().createReader(file).readAll();
    const plainLength = fs.statSync(file).size;
    const compressed = compress(file);

    const plain = new CodexProvider();
    expect(await plain.listSessionFilesAsync(repo)).toEqual([]);
    expect(plain.findSessionById(repo, SESSION_ID)).toBe(null);
    expect(plain.isSessionFile(path.basename(compressed))).toBe(false);

    const provider = new CodexProvider({ includeCompressedRollouts: true });
    const listed = await provider.listSessionFilesAsync(repo);
    expect(listed.map((f) => [f.path, f.sessionId, f.workspacePath])).toEqual([
      [compressed, SESSION_ID, repo],
    ]);
    expect(provider.findAllSessions(repo)).toEqual([compressed]);
    expect(provider.findSessionById(repo, SESSION_ID)).toBe(compressed);
    expect(provider.isSessionFile(path.basename(compressed))).toBe(true);
    expect(provider.getSessionId(compressed)).toBe(SESSION_ID);
    expect(provider.extractSessionLabel(compressed)).toBe('first compressed prompt');
    expect((await provider.extractSessionLabelsAsync([compressed])).get(compressed)).toBe(
      'first compressed prompt',
    );
    expect(provider.searchInSession(compressed, 'second compressed', 5)).toHaveLength(1);

    const reader = provider.createReader(compressed);
    expect(reader.readAll()).toEqual(plainEvents);
    expect(reader.readNew()).toEqual([]);
    expect(reader.getPosition()).toBe(plainLength);
    // Seek and resume like a persisted cursor.
    const position = reader.getPosition();
    const resumed = provider.createReader(compressed);
    resumed.seekTo(position);
    expect(resumed.readNew()).toEqual([]);
    expect(provider.readSessionStats(compressed).toolUsage).toEqual({ Bash: 1 });

    // The factory passes the option through.
    const [fromFactory] = createSessionProviders({
      providerIds: ['codex'],
      includeCompressedRollouts: true,
    }).providers;
    expect((await fromFactory.listSessionFilesAsync!(repo)).map((f) => f.path)).toEqual([
      compressed,
    ]);
  });

  it('does not list compressed sessions it cannot read', async () => {
    const file = `${rolloutFile()}.zst`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]));
    __compressedRolloutTesting.setDecompress(null);
    const diagnostics: SessionProviderDiagnostic[] = [];
    const provider = new CodexProvider({
      includeCompressedRollouts: true,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(await provider.listSessionFilesAsync()).toEqual([]);
    expect(provider.listAllSessionFiles()).toEqual([]);
    expect(diagnostics.map((d) => d.kind)).toEqual(['read_failed']);
  });
});

describe('compressed rollouts in usage and prompt history', () => {
  it.skipIf(!hasZstd)('match the uncompressed session, with cursors that carry over', async () => {
    const file = rolloutFile();
    writeJsonl(file, interactiveRows());
    const provider = new CodexProvider({ includeCompressedRollouts: true });
    const before = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
    });
    const usageBefore = await collectUsageEvents({ providers: [provider], noCache: true });
    expect(before.entries.map((e) => e.text)).toEqual([
      'first compressed prompt',
      'second compressed prompt',
    ]);

    const compressed = compress(file);
    const fresh = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
    });
    const strip = (entries: typeof fresh.entries) =>
      entries.map(({ sessionKey: _key, ...entry }) => entry);
    expect(strip(fresh.entries)).toEqual(strip(before.entries));
    expect(
      (await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] })).entries,
    ).toEqual([]);

    // The cursor from the `.jsonl` carries over to the `.zst`: nothing is returned twice.
    const continued = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
      cursor: before.cursor,
    });
    expect(continued.entries).toEqual([]);
    const again = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
      cursor: continued.cursor,
    });
    expect(again.stats.sessionsSkippedUnchanged).toBe(1);

    const sessions = await collectSessionPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
    });
    expect(sessions.sessions.map((s) => s.prompts.length)).toEqual([2]);

    // Usage: same events and prompt ordinals; the cache keys on the compressed file.
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    const shape = (events: typeof miss.events) =>
      events.map(({ filePath: _file, ...event }) => event);
    expect(shape(miss.events)).toEqual(shape(usageBefore.events));
    expect(miss.events.map((e) => e.promptOrdinal)).toEqual([0]);
    expect(miss.events[0].filePath).toBe(compressed);
    expect(hit.cacheHits).toBe(1);
    // Keyed on the compressed file's size (and mtime).
    expect(miss.sessions[0].fingerprint.split(':')[0]).toBe(String(fs.statSync(compressed).size));

    const origins = await findToolCallOrigins({
      ids: ['call_zst_exec'],
      workspacePaths: [repo],
      providers: ['codex'],
      includeCompressedRollouts: true,
    });
    expect(origins.get('call_zst_exec')).toMatchObject({
      sessionId: SESSION_ID,
      filePath: compressed,
      afterOrdinal: 0,
    });
    expect(
      (
        await findToolCallOrigins({
          ids: ['call_zst_exec'],
          workspacePaths: [repo],
          providers: ['codex'],
        })
      ).size,
    ).toBe(0);
  });
});
