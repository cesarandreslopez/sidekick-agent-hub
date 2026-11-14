/**
 * `collectUsageEvents` reads sessions in bounded steps, yielding between
 * them, and a deadline (or an abort) can stop it inside a session: progress
 * is kept in the usage cache and the next call continues from it. Whatever
 * the step size and wherever the calls stop, the events delivered equal one
 * uninterrupted read, and a result never holds part of a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('../providers/codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }
    open(): boolean {
      return false;
    }
    close(): void {}
    getRuntimeStatus() {
      return { available: false, kind: 'db_missing' };
    }
    async getThreadsByIdsAsync() {
      return [];
    }
  },
}));

import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import { __compressedRolloutTesting } from '../providers/compressedRollouts';
import type { SessionProviderBase } from '../providers/types';
import {
  appendJsonl,
  claudeFiller,
  createSessionLogFixtures,
  ts,
  writeJsonl,
  type Row,
} from '../testing/sessionLogFixtures';
import {
  USAGE_CACHE_VERSION,
  __usageEventsTesting,
  collectUsageEvents,
  getUsageCacheDir,
  type CollectUsageEventsOptions,
  type UsageEventRecord,
} from './usageEvents';

let repo: string;
let claude: ClaudeCodeProvider;
let codex: CodexProvider;
const fx = createSessionLogFixtures(() => ({ home: tmpDir, repo }));

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-resume-')));
  repo = path.join(tmpDir, 'work', 'app');
  fs.mkdirSync(repo, { recursive: true });
  claude = new ClaudeCodeProvider({ homes: { claudeHomes: [path.join(tmpDir, '.claude')] } });
  codex = new CodexProvider({ homes: { codexHomes: [path.join(tmpDir, '.codex')] } });
});

afterEach(() => {
  __usageEventsTesting.setReadChunkBytes(null);
  __compressedRolloutTesting.setDecompress(undefined);
  vi.restoreAllMocks();
  claude.dispose();
  codex.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 40,
});

/** A Claude Code session with split responses (corrections), a placeholder, and two subagents. */
function claudeSession(id = 'resume-main'): string {
  const file = fx.claudeFile(repo, id);
  writeJsonl(file, [
    fx.claudeUser('first prompt — ünïcødé 🚀', 1),
    fx.claudeAssistant('m1', 2, {}, { usage: usage(10, 1) }),
    // The same response again, grown: a correction merged into m1.
    fx.claudeAssistant(
      'm1',
      3,
      {},
      {
        usage: usage(10, 25),
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a' } }],
      },
    ),
    fx.claudeUser('second prompt', 4),
    fx.claudeAssistant('m2', 5),
    fx.claudeAssistant('m3', 6, {}, { model: '<synthetic>', usage: usage(0, 0) }),
    fx.claudeUser('third prompt', 7),
    fx.claudeAssistant('m4', 8, {}, { usage: usage(5, 2) }),
    fx.claudeAssistant('m4', 9, {}, { usage: usage(5, 50) }),
    fx.claudeAssistant('m5', 10),
  ]);
  const subagents = path.join(path.dirname(file), id, 'subagents');
  for (const [agent, second] of [
    ['a1', 11],
    ['b2', 20],
  ] as const) {
    writeJsonl(path.join(subagents, `agent-${agent}.jsonl`), subagentRows(agent, second));
  }
  return file;
}

function subagentRows(agent: string, second: number): Row[] {
  return [
    fx.claudeUser(`task for ${agent}`, second, { isSidechain: true }),
    fx.claudeAssistant(`${agent}-s1`, second + 1, { isSidechain: true }, { usage: usage(3, 1) }),
    fx.claudeAssistant(`${agent}-s1`, second + 2, { isSidechain: true }, { usage: usage(3, 40) }),
    fx.claudeAssistant(`${agent}-s2`, second + 3, { isSidechain: true }),
  ];
}

function subagentFile(sessionFile: string, agent: string): string {
  const id = path.basename(sessionFile, '.jsonl');
  return path.join(path.dirname(sessionFile), id, 'subagents', `agent-${agent}.jsonl`);
}

const codexTotal = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  total_tokens: input + output,
});
const codexTokens = (second: number, total: ReturnType<typeof codexTotal>): Row => ({
  timestamp: ts(second),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total } },
});

/** A Codex rollout with running totals only, a duplicate total, and a model change. */
function codexSession(): string {
  const file = fx.codexFile();
  writeJsonl(file, [
    fx.codexMeta(repo),
    { timestamp: ts(1), type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: repo } },
    fx.codexUser(['first codex prompt'], 2),
    codexTokens(3, codexTotal(1000, 400, 50)),
    codexTokens(4, codexTotal(1000, 400, 50)),
    fx.codexUser(['second codex prompt'], 5),
    { timestamp: ts(6), type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd: repo } },
    codexTokens(7, codexTotal(2500, 900, 120)),
    codexTokens(9, codexTotal(4000, 1500, 200)),
  ]);
  return file;
}

/** A plain Claude Code session of `calls` responses. */
function plainSession(id: string, calls: number): string {
  const file = fx.claudeFile(repo, id);
  writeJsonl(file, [
    fx.claudeUser('hello', 1),
    ...Array.from({ length: calls }, (_, index) =>
      fx.claudeAssistant(`${id}-m${index}`, 2 + index),
    ),
  ]);
  return file;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collect(extra: Partial<CollectUsageEventsOptions> = {}) {
  return collectUsageEvents({ providers: [claude, codex], workspacePaths: [repo], ...extra });
}

function sorted(events: readonly UsageEventRecord[]): UsageEventRecord[] {
  return [...events].sort(
    (a, b) =>
      (a.sessionKey ?? '').localeCompare(b.sessionKey ?? '') ||
      a.timestamp - b.timestamp ||
      (a.requestId ?? '').localeCompare(b.requestId ?? ''),
  );
}

/** One uninterrupted read of everything there is now. */
async function oneShot(): Promise<UsageEventRecord[]> {
  return sorted((await collect({ noCache: true })).events);
}

/** Calls again with the cursor until nothing is left; every event delivered, in order. */
async function drain(extra: Partial<CollectUsageEventsOptions>, limit = 3000) {
  const events: UsageEventRecord[] = [];
  let cursor: CollectUsageEventsOptions['cursor'];
  for (let calls = 1; calls <= limit; calls++) {
    const result = await collect({ ...extra, cursor });
    events.push(...result.events);
    cursor = JSON.parse(JSON.stringify(result.cursor));
    if (!result.hasMore) return { events, calls };
  }
  throw new Error('the calls never ended');
}

function cacheFile(provider: string, sessionId: string): string {
  return path.join(getUsageCacheDir(), `${provider}--${sessionId}.v${USAGE_CACHE_VERSION}.json`);
}

interface PartialEntry {
  fingerprint: string;
  events: unknown[];
  partial?: { v: number; k: string; tx: Array<{ n: string; p: number; e: unknown }> };
}

function cacheEntry(sessionId: string, provider = 'claude-code'): PartialEntry | null {
  const file = cacheFile(provider, sessionId);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as PartialEntry) : null;
}

/** Records every position a reader of `provider` is sought to. */
function trackSeeks(provider: SessionProviderBase): number[] {
  const seeks: number[] = [];
  const create = provider.createReader.bind(provider);
  vi.spyOn(provider, 'createReader').mockImplementation((file, options) => {
    const reader = create(file, options);
    const seekTo = reader.seekTo.bind(reader);
    reader.seekTo = (position: number) => {
      seeks.push(position);
      seekTo(position);
    };
    return reader;
  });
  return seeks;
}

/** Moves the mtime forward, as a later write would. */
function bumpMtime(file: string): void {
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
}

/** Deadline-stopped calls (no cursor) until `ready` holds for the session's partial entry. */
async function advanceUntil(sessionId: string, ready: (entry: PartialEntry) => boolean) {
  for (let call = 0; call < 500; call++) {
    const result = await collect({ bounds: { deadlineMs: 0 } });
    expect(result.hasMore).toBe(true);
    const entry = cacheEntry(sessionId);
    if (entry?.partial && ready(entry)) return entry;
  }
  throw new Error('the partial entry never got there');
}

// ── Equivalence ─────────────────────────────────────────────────────────────

describe('collectUsageEvents resumed across deadline-stopped calls', () => {
  it.each([64, 1024, 64 * 1024])(
    'in %i-byte steps delivers exactly what one read does',
    async (chunk) => {
      claudeSession();
      codexSession();
      const expected = await oneShot();
      expect(expected.length).toBeGreaterThan(8);
      expect(expected.some((event) => event.subagent?.agentId === 'a1')).toBe(true);
      expect(expected.some((event) => event.provider === 'codex')).toBe(true);

      __usageEventsTesting.setReadChunkBytes(chunk);
      const seeks = trackSeeks(claude);
      const { events, calls } = await drain({ bounds: { deadlineMs: 0 } });
      expect(calls).toBeGreaterThan(2);
      expect(sorted(events)).toEqual(expected);
      if (chunk === 64) expect(seeks.some((position) => position > 0)).toBe(true);

      // Every entry is complete now; the next call is served from the cache.
      for (const name of fs.readdirSync(getUsageCacheDir())) {
        const entry = JSON.parse(fs.readFileSync(path.join(getUsageCacheDir(), name), 'utf8'));
        expect(entry.partial).toBeUndefined();
        expect(String(entry.fingerprint).startsWith('partial:')).toBe(false);
      }
      const again = await collect();
      expect(again.cacheMisses).toBe(0);
      expect(sorted(again.events)).toEqual(expected);
    },
  );

  it('keeps a stopped session out of the result and the cursor', async () => {
    claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    const first = await collect({ bounds: { deadlineMs: 0 } });
    expect(first).toMatchObject({ hasMore: true, boundsHit: ['deadline'], events: [] });
    expect(first.sessions).toEqual([]);
    expect(first.changed).toEqual([]);
    expect(first.cacheMisses).toBe(1);
    expect(Object.keys(first.cursor.sessions)).toEqual([]);
    expect(first.cursor.next).toEqual(expect.any(String));
    const entry = cacheEntry('resume-main')!;
    expect(entry.fingerprint.startsWith('partial:')).toBe(true);
    expect(entry.events).toEqual([]);
    expect(entry.partial?.tx[0]).toMatchObject({ n: '', p: expect.any(Number) });
    expect(entry.partial!.tx[0].p).toBeGreaterThan(0);
  });

  it('continues an appended session from where the last call stopped', async () => {
    const file = claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await advanceUntil('resume-main', (entry) => entry.partial!.tx[0].p > 0);
    appendJsonl(file, [fx.claudeUser('later prompt', 40), fx.claudeAssistant('m9', 41)]);
    bumpMtime(file);
    const seeks = trackSeeks(claude);
    const done = await collect();
    expect(seeks.some((position) => position > 0)).toBe(true);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it.each(['rewrite', 'replace', 'truncate'] as const)(
    'starts a transcript over after a %s between calls',
    async (change) => {
      const file = claudeSession();
      __usageEventsTesting.setReadChunkBytes(64);
      await advanceUntil('resume-main', (entry) => entry.partial!.tx[0].p > 1500);
      const content = fs.readFileSync(file, 'utf8');
      const rows = content.split('\n').filter(Boolean);
      // Same size, different usage before the resume point: kept progress would be wrong.
      const changed = content.replace('"output_tokens":25', '"output_tokens":99');
      expect(content.indexOf('"output_tokens":25')).toBeLessThan(1500);
      if (change === 'rewrite') {
        fs.writeFileSync(file, changed);
        bumpMtime(file);
      } else if (change === 'replace') {
        fs.writeFileSync(`${file}.next`, changed);
        fs.renameSync(`${file}.next`, file);
      } else {
        fs.writeFileSync(file, rows.slice(0, 3).join('\n') + '\n');
        bumpMtime(file);
      }
      const seeks = trackSeeks(claude);
      const done = await collect();
      expect(seeks.some((position) => position > 0)).toBe(true);
      expect(sorted(done.events)).toEqual(await oneShot());
    },
  );

  it('reads a subagent transcript that appeared between calls', async () => {
    const file = claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await advanceUntil('resume-main', (entry) => entry.partial!.tx[0].p > 0);
    writeJsonl(subagentFile(file, 'c3'), subagentRows('c3', 30));
    const done = await collect();
    expect(done.events.some((event) => event.subagent?.agentId === 'c3')).toBe(true);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('continues a finished subagent transcript that grew between calls', async () => {
    const file = claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await advanceUntil('resume-main', (entry) =>
      entry.partial!.tx.some((tx) => tx.n === 'agent-a1.jsonl'),
    );
    const agent = subagentFile(file, 'a1');
    appendJsonl(agent, [fx.claudeAssistant('a1-s9', 35, { isSidechain: true })]);
    bumpMtime(agent);
    const done = await collect();
    expect(done.events.some((event) => event.requestId === 'a1-s9')).toBe(true);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('drops a subagent transcript deleted between calls', async () => {
    const file = claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await advanceUntil('resume-main', (entry) =>
      entry.partial!.tx.some((tx) => tx.n === 'agent-a1.jsonl'),
    );
    fs.rmSync(subagentFile(file, 'a1'));
    const done = await collect();
    expect(done.events.some((event) => event.subagent?.agentId === 'a1')).toBe(false);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('gets past a line longer than a step, one committed line per call at least', async () => {
    const file = fx.claudeFile(repo, 'long-line');
    writeJsonl(file, [
      fx.claudeUser(`huge ${'x'.repeat(5000)}`, 1),
      fx.claudeAssistant('long-m1', 2),
      fx.claudeUser(`huge again ${'y'.repeat(5000)}`, 3),
      fx.claudeAssistant('long-m2', 4),
    ]);
    const expected = await oneShot();
    __usageEventsTesting.setReadChunkBytes(64);
    const { events, calls } = await drain({ bounds: { deadlineMs: 0 } });
    expect(calls).toBeLessThan(20);
    expect(sorted(events)).toEqual(expected);
  });
});

// ── Without a cache, aborts, and bad entries ────────────────────────────────

describe('collectUsageEvents stop rules', () => {
  it('without a cache, reads the first session whole and stops before the next', async () => {
    plainSession('one', 6);
    plainSession('two', 6);
    __usageEventsTesting.setReadChunkBytes(64);
    const result = await collect({ noCache: true, bounds: { deadlineMs: 0 } });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].eventCount).toBe(6);
    expect(result).toMatchObject({ hasMore: true, boundsHit: ['deadline'] });
    expect(fs.existsSync(getUsageCacheDir())).toBe(false);
  });

  it('keeps the progress of a session an abort interrupts, then rejects', async () => {
    claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    const controller = new AbortController();
    const create = claude.createReader.bind(claude);
    let steps = 0;
    vi.spyOn(claude, 'createReader').mockImplementation((file, options) => {
      const reader = create(file, options);
      const step = reader.readNewBounded!.bind(reader);
      reader.readNewBounded = (maxBytes: number) => {
        steps += 1;
        if (steps === 20) controller.abort();
        return step(maxBytes);
      };
      return reader;
    });
    await expect(collect({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(steps).toBe(20);
    const entry = cacheEntry('resume-main')!;
    expect(entry.partial).toBeDefined();
    expect(entry.events).toEqual([]);
    vi.restoreAllMocks();

    const seeks = trackSeeks(claude);
    const done = await collect();
    expect(seeks.some((position) => position > 0)).toBe(true);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('never serves a partial entry as a complete one, even with a real fingerprint', async () => {
    claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await collect({ bounds: { deadlineMs: 0 } });
    const file = cacheFile('claude-code', 'resume-main');
    const entry = cacheEntry('resume-main')!;
    fs.writeFileSync(
      file,
      JSON.stringify({ ...entry, fingerprint: entry.fingerprint.slice('partial:'.length) }),
    );
    const done = await collect();
    expect(done.cacheHits).toBe(0);
    expect(done.cacheMisses).toBe(1);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('reads a session afresh when its partial entry is corrupt', async () => {
    claudeSession();
    __usageEventsTesting.setReadChunkBytes(64);
    await advanceUntil('resume-main', (entry) => entry.partial!.tx[0].p > 0);
    const entry = cacheEntry('resume-main')!;
    entry.partial!.tx[0].e = 'not events';
    fs.writeFileSync(cacheFile('claude-code', 'resume-main'), JSON.stringify(entry));
    const seeks = trackSeeks(claude);
    const done = await collect();
    expect(seeks.filter((position) => position > 0)).toEqual([]);
    expect(sorted(done.events)).toEqual(await oneShot());
  });

  it('counts only the unread rest of a resumed session toward maxTotalBytes', async () => {
    const one = plainSession('aaa', 12);
    const two = plainSession('bbb', 12);
    __usageEventsTesting.setReadChunkBytes(64);
    const first = await collect({ bounds: { deadlineMs: 0 } });
    expect(first.hasMore).toBe(true);
    const stopped = ['aaa', 'bbb'].find((id) => cacheEntry(id)?.partial)!;
    const read = cacheEntry(stopped)!.partial!.tx[0].p;
    expect(read).toBeGreaterThan(0);
    const [stoppedFile, otherFile] = stopped === 'aaa' ? [one, two] : [two, one];
    const rest = fs.statSync(stoppedFile).size - read;
    // The whole stopped session plus the other would not fit; its rest plus the other does.
    const maxTotalBytes = rest + fs.statSync(otherFile).size;
    const second = await collect({
      cursor: JSON.parse(JSON.stringify(first.cursor)),
      bounds: { maxTotalBytes },
    });
    expect(second.hasMore).toBe(false);
    expect(second.sessions.map((session) => session.sessionId).sort()).toEqual(['aaa', 'bbb']);
  });
});

// ── Responsiveness and compressed rollouts ──────────────────────────────────

describe('collectUsageEvents responsiveness', () => {
  it('yields to the event loop while it reads one large session', async () => {
    const file = fx.claudeFile(repo, 'large');
    writeJsonl(file, [
      fx.claudeUser('go', 1),
      ...Array.from({ length: 1000 }, (_, index) => claudeFiller(4000, 2 + (index % 50))),
      fx.claudeAssistant('large-m1', 59),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(4_000_000);
    __usageEventsTesting.setReadChunkBytes(64 * 1024);
    let ticks = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const result = await collect({ noCache: true });
    running = false;
    expect(result.events).toHaveLength(1);
    expect(ticks).toBeGreaterThanOrEqual(32);
  });

  it('reads a compressed rollout whole, without keeping partial progress', async () => {
    __compressedRolloutTesting.setDecompress((input) => input);
    const plain = codexSession();
    fs.renameSync(plain, `${plain}.zst`);
    const compressed = new CodexProvider({
      homes: { codexHomes: [path.join(tmpDir, '.codex')] },
      includeCompressedRollouts: true,
    });
    try {
      __usageEventsTesting.setReadChunkBytes(64);
      const result = await collectUsageEvents({
        providers: [compressed],
        workspacePaths: [repo],
        bounds: { deadlineMs: 0 },
      });
      expect(result.hasMore).toBe(false);
      expect(result.events.length).toBeGreaterThan(0);
      for (const name of fs.readdirSync(getUsageCacheDir())) {
        const entry = JSON.parse(fs.readFileSync(path.join(getUsageCacheDir(), name), 'utf8'));
        expect(entry.partial).toBeUndefined();
      }
    } finally {
      compressed.dispose();
    }
  });
});
