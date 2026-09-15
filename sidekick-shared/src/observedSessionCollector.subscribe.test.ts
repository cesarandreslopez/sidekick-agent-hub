/**
 * Event-scoped reconciliation, coalescing, discovery reuse, and cache bounds
 * of ObservedSessionCollector. Filesystem-backed cases drive a real
 * ClaudeCodeProvider over a temp home and count the stat/readdir calls the
 * collector causes; watch signals are injected, never taken from fs.watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const calls = vi.hoisted(() => ({ readdir: [] as string[], stat: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: ((...args: Parameters<typeof actual.promises.readdir>) => {
        calls.readdir.push(String(args[0]));
        return (actual.promises.readdir as (...a: unknown[]) => unknown)(...args);
      }) as typeof actual.promises.readdir,
      stat: ((...args: Parameters<typeof actual.promises.stat>) => {
        calls.stat.push(String(args[0]));
        return (actual.promises.stat as (...a: unknown[]) => unknown)(...args);
      }) as typeof actual.promises.stat,
    },
  };
});

import {
  ObservedSessionCollector,
  observedSessionSourceFromProvider,
  type ObservedSessionChangeBatch,
  type ObservedSessionCollectionSource,
  type ObservedSessionDiagnostic,
  type ObservedSessionSourceListener,
} from './observedSessionCollector';
import { ClaudeCodeProvider } from './providers/claudeCode';

const FAKE_TIMERS = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const,
};

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function ageDirectory(dir: string): void {
  const when = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(dir, when, when);
}

/** Sessions written a while ago so their directory listing is trusted at once. */
function writeSession(dir: string, name: string, content = '{"type":"user"}\n'): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  const when = new Date(Date.now() - 2 * 60 * 60_000);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

function summarize(batch: ObservedSessionChangeBatch): string[] {
  return batch.changes.map((change) => `${change.type}:${change.reference.sessionId}`);
}

describe('ObservedSessionCollector over a Claude Code home', () => {
  let home: string;
  let projectsRoot: string;
  let projectDir: string;
  let previousHome: string | undefined;
  let invalidate: ObservedSessionSourceListener | undefined;
  const batches: ObservedSessionChangeBatch[] = [];
  const diagnostics: ObservedSessionDiagnostic[] = [];
  let collector: ObservedSessionCollector;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-collector-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    projectsRoot = path.join(home, '.claude', 'projects');
    projectDir = path.join(projectsRoot, '-Users-me-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    batches.length = 0;
    diagnostics.length = 0;
    calls.readdir.length = 0;
    calls.stat.length = 0;
  });

  afterEach(() => {
    collector?.dispose();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function start(): ObservedSessionCollector {
    const provider = new ClaudeCodeProvider();
    const source = observedSessionSourceFromProvider(provider, '', { observationOnly: true });
    // Signals are injected; a real recursive watcher would race the test.
    const injected: ObservedSessionCollectionSource<unknown> = {
      ...source,
      subscribe: (listener) => {
        invalidate = listener;
        return { dispose: () => undefined };
      },
    };
    collector = new ObservedSessionCollector({
      sources: [injected],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    collector.subscribe((batch) => batches.push(batch), { debounceMs: 0, pollIntervalMs: 0 });
    return collector;
  }

  it('reconciles one append event with one stat and no directory listing', async () => {
    const sessionPath = writeSession(projectDir, 'abc.jsonl');
    ageDirectory(projectDir);
    ageDirectory(projectsRoot);
    start();
    await waitFor(() => batches.length === 1);
    expect(summarize(batches[0])).toEqual(['added:abc']);
    expect(diagnostics[0]).toMatchObject({
      kind: 'provider-discovery-completed',
      severity: 'info',
      phase: 'discover',
      providerId: 'claude-code',
      trigger: 'initial',
      referenceCount: 1,
      directoriesListed: 2,
      filesStatted: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('abc');

    calls.readdir.length = 0;
    calls.stat.length = 0;
    fs.appendFileSync(sessionPath, '{"type":"assistant"}\n');
    invalidate?.({
      trigger: 'event',
      root: projectsRoot,
      eventType: 'change',
      filename: '-Users-me-proj/abc.jsonl',
    });
    await waitFor(() => batches.length === 2);

    expect(summarize(batches[1])).toEqual(['changed:abc']);
    expect(calls.readdir).toEqual([]);
    expect(calls.stat).toEqual([sessionPath]);
    expect(diagnostics).toHaveLength(1);
  });

  it('ignores subagent transcripts and foreign extensions without touching the filesystem', async () => {
    writeSession(projectDir, 'abc.jsonl');
    ageDirectory(projectDir);
    ageDirectory(projectsRoot);
    start();
    await waitFor(() => batches.length === 1);
    calls.readdir.length = 0;
    calls.stat.length = 0;

    invalidate?.({
      trigger: 'event',
      root: projectsRoot,
      filename: '-Users-me-proj/abc/subagents/agent-1.jsonl',
    });
    invalidate?.({ trigger: 'event', root: projectsRoot, filename: '-Users-me-proj/notes.md' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(batches).toHaveLength(1);
    expect(calls.readdir).toEqual([]);
    expect(calls.stat).toEqual([]);
  });

  it('does not report an empty new file, then reports it once it has content', async () => {
    writeSession(projectDir, 'abc.jsonl');
    ageDirectory(projectDir);
    ageDirectory(projectsRoot);
    start();
    await waitFor(() => batches.length === 1);

    const fresh = path.join(projectDir, 'new.jsonl');
    fs.writeFileSync(fresh, '');
    invalidate?.({
      trigger: 'event',
      root: projectsRoot,
      eventType: 'rename',
      filename: '-Users-me-proj/new.jsonl',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toHaveLength(1);

    fs.appendFileSync(fresh, '{"type":"user"}\n');
    invalidate?.({
      trigger: 'event',
      root: projectsRoot,
      eventType: 'change',
      filename: '-Users-me-proj/new.jsonl',
    });
    await waitFor(() => batches.length === 2);
    expect(summarize(batches[1])).toEqual(['added:new']);
  });

  it('a catch-up poll detects added and removed sessions and growth the watcher missed', async () => {
    const abc = writeSession(projectDir, 'abc.jsonl');
    const live = path.join(projectDir, 'live.jsonl');
    fs.writeFileSync(live, '{"type":"user"}\n'); // recent: eligible for revalidation
    ageDirectory(projectDir);
    ageDirectory(projectsRoot);
    start();
    await waitFor(() => batches.length === 1);
    expect(summarize(batches[0]).sort()).toEqual(['added:abc', 'added:live']);

    // Growth only: the directory's mtime does not change on an append.
    fs.appendFileSync(live, '{"type":"assistant"}\n');
    invalidate?.({ trigger: 'poll' });
    await waitFor(() => batches.length === 2);
    expect(summarize(batches[1])).toEqual(['changed:live']);
    expect(diagnostics.at(-1)).toMatchObject({ trigger: 'poll', directoriesListed: 0 });

    fs.rmSync(abc);
    writeSession(projectDir, 'def.jsonl');
    ageDirectory(projectDir);
    invalidate?.({ trigger: 'poll' });
    await waitFor(() => batches.length === 3);
    expect(summarize(batches[2]).sort()).toEqual(['added:def', 'removed:abc']);
  });

  it('a removed session reported by the watcher is emitted as removed', async () => {
    const abc = writeSession(projectDir, 'abc.jsonl');
    ageDirectory(projectDir);
    ageDirectory(projectsRoot);
    start();
    await waitFor(() => batches.length === 1);
    fs.rmSync(abc);
    invalidate?.({
      trigger: 'event',
      root: projectsRoot,
      eventType: 'rename',
      filename: '-Users-me-proj/abc.jsonl',
    });
    await waitFor(() => batches.length === 2);
    expect(summarize(batches[1])).toEqual(['removed:abc']);
    expect(batches[1].changes[0].previousFingerprint).not.toBeNull();
  });
});

describe('ObservedSessionCollector coalescing and discovery reuse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface FakeSourceState {
    fingerprint: string;
    discoverCalls: number;
    resolveCalls: number;
    discoverDurationMs: number;
    listeners: ObservedSessionSourceListener[];
    block: Promise<void> | null;
  }

  function fakeSource(state: FakeSourceState): ObservedSessionCollectionSource<string> {
    return {
      providerId: 'fake',
      discover: async () => {
        state.discoverCalls++;
        const fingerprint = state.fingerprint;
        if (state.block) await state.block;
        vi.setSystemTime(Date.now() + state.discoverDurationMs);
        return [{ sessionId: 'a', fingerprintHint: fingerprint }];
      },
      read: () => 'value',
      subscribe: (listener) => {
        state.listeners.push(listener);
        return { dispose: () => undefined };
      },
      resolveReference: (signal) => {
        state.resolveCalls++;
        if (signal.filename !== 'a.jsonl') return { status: 'ignored' };
        return {
          status: 'present',
          reference: { sessionId: 'a', fingerprintHint: state.fingerprint },
        };
      },
    };
  }

  function newState(discoverDurationMs: number): FakeSourceState {
    return {
      fingerprint: '1:1',
      discoverCalls: 0,
      resolveCalls: 0,
      discoverDurationMs,
      listeners: [],
      block: null,
    };
  }

  it('twenty signals inside one gap produce one scoped stat and at most one trailing full pass', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const state = newState(500);
    const batches: ObservedSessionChangeBatch[] = [];
    const diagnostics: ObservedSessionDiagnostic[] = [];
    const collector = new ObservedSessionCollector({
      sources: [fakeSource(state)],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    collector.subscribe((batch) => batches.push(batch), { debounceMs: 10, pollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(state.discoverCalls).toBe(1);
    expect(summarize(batches[0])).toEqual(['added:a']);

    state.fingerprint = '2:2';
    const signal = state.listeners[0];
    for (let index = 0; index < 20; index++) {
      switch (index % 4) {
        case 0:
          signal(); // legacy: no argument
          break;
        case 1:
          signal('change'); // legacy: handed straight to fs.watch
          break;
        case 2:
          signal({ trigger: 'event', root: '/r', filename: null });
          break;
        default:
          signal({ trigger: 'event', root: '/r', filename: 'a.jsonl' });
      }
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(state.resolveCalls).toBe(1);
    expect(state.discoverCalls).toBe(1);
    expect(batches).toHaveLength(2);
    expect(summarize(batches[1])).toEqual(['changed:a']);

    // The full pass waits for the gap (500 ms walk × 4, capped at 2 s).
    state.fingerprint = '3:3';
    await vi.advanceTimersByTimeAsync(1_900);
    expect(state.discoverCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.discoverCalls).toBe(2);
    expect(summarize(batches[2])).toEqual(['changed:a']);
    expect(diagnostics.map((d) => d.trigger)).toEqual(['initial', 'event']);
    collector.dispose();
  });

  it('a cheap source is not held back by the gap ceiling', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const state = newState(0);
    const batches: ObservedSessionChangeBatch[] = [];
    const collector = new ObservedSessionCollector({ sources: [fakeSource(state)] });
    collector.subscribe((batch) => batches.push(batch), { debounceMs: 0, pollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    state.fingerprint = '2:2';
    state.listeners[0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.discoverCalls).toBe(2);
    expect(summarize(batches[1])).toEqual(['changed:a']);
    collector.dispose();
  });

  it('collect() inside the listener reuses the reconcile pass and shares an in-flight walk', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const state = newState(100);
    const source = fakeSource(state);
    const collector = new ObservedSessionCollector({
      sources: [source],
      yieldBetweenReads: () => undefined,
    });
    const collected: string[] = [];
    collector.subscribe(
      () => {
        void collector
          .collect()
          .then((rows) => collected.push(...rows.map((row) => row.fingerprint ?? '')));
      },
      { debounceMs: 0, pollIntervalMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(state.discoverCalls).toBe(1);
    expect(collected).toEqual(['1:1']);

    // Scoped change: the listener's collect() sees the new fingerprint with no walk.
    state.fingerprint = '2:2';
    state.listeners[0]({ trigger: 'event', root: '/r', filename: 'a.jsonl' });
    await vi.advanceTimersByTimeAsync(1);
    expect(state.discoverCalls).toBe(1);
    expect(collected).toEqual(['1:1', '2:2']);

    // Past the gap, collect() discovers again; a concurrent walk is shared.
    await vi.advanceTimersByTimeAsync(1_000);
    let release: () => void = () => undefined;
    state.block = new Promise<void>((resolve) => (release = resolve));
    state.listeners[0]();
    await vi.advanceTimersByTimeAsync(1);
    const concurrent = collector.collect();
    expect(state.discoverCalls).toBe(2);
    release();
    await concurrent;
    expect(state.discoverCalls).toBe(2);
    collector.dispose();
  });

  it('a walk in flight cannot undo a scoped result that landed while it ran', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const state = newState(100);
    const collector = new ObservedSessionCollector({
      sources: [fakeSource(state)],
      yieldBetweenReads: () => undefined,
    });
    const first: ObservedSessionChangeBatch[] = [];
    const second: ObservedSessionChangeBatch[] = [];
    collector.subscribe((batch) => first.push(batch), { debounceMs: 0, pollIntervalMs: 0 });
    collector.subscribe((batch) => second.push(batch), { debounceMs: 0, pollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Sequential initial passes: the first completed before the second was armed.
    expect(state.discoverCalls).toBe(2);

    // Subscription one starts a full walk that captured '1:1' and stalls.
    let release: () => void = () => undefined;
    state.block = new Promise<void>((resolve) => (release = resolve));
    state.listeners[0]();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.discoverCalls).toBe(3);

    // Subscription two reconciles the file's newer state meanwhile.
    state.fingerprint = '2:2';
    state.listeners[1]({ trigger: 'event', root: '/r', filename: 'a.jsonl' });
    await vi.advanceTimersByTimeAsync(1);
    expect(summarize(second[1])).toEqual(['changed:a']);

    release();
    state.block = null;
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toHaveLength(2);
    expect(first[1].changes[0]).toMatchObject({ type: 'changed', fingerprint: '2:2' });
    const rows = await collector.collect();
    expect(rows[0].fingerprint).toBe('2:2');
    expect(state.discoverCalls).toBe(3);
    collector.dispose();
  });

  it('a walk started by collect() before a scoped result cannot undo it when a pass joins the walk', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const state = newState(100);
    const collector = new ObservedSessionCollector({
      sources: [fakeSource(state)],
      yieldBetweenReads: () => undefined,
    });
    const batches: ObservedSessionChangeBatch[] = [];
    collector.subscribe((batch) => batches.push(batch), { debounceMs: 0, pollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    expect(state.discoverCalls).toBe(1);

    // Past the gap, a host collect() starts a full walk that captured '1:1' and stalls.
    await vi.advanceTimersByTimeAsync(1_000);
    let release: () => void = () => undefined;
    state.block = new Promise<void>((resolve) => (release = resolve));
    const walk = collector.collect();
    expect(state.discoverCalls).toBe(2);

    // The file changes and its scoped event lands while that walk is in flight.
    state.fingerprint = '2:2';
    state.listeners[0]({ trigger: 'event', root: '/r', filename: 'a.jsonl' });
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].changes[0]).toMatchObject({ type: 'changed', fingerprint: '2:2' });

    // An unscoped signal now joins the in-flight walk rather than starting its own.
    state.listeners[0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.discoverCalls).toBe(2);

    release();
    state.block = null;
    await walk;
    await vi.advanceTimersByTimeAsync(1);
    // The walk's stale '1:1' copy must not be reported as a change back.
    expect(batches).toHaveLength(2);
    const rows = await collector.collect();
    expect(rows[0].fingerprint).toBe('2:2');
    expect(state.discoverCalls).toBe(2);
    collector.dispose();
  });
});

describe('ObservedSessionCollector cache bounds', () => {
  function boundedCollector(
    options: { maxCacheEntries?: number; maxCacheBytes?: number },
    references: () => string[],
    reads: Map<string, number>,
  ): ObservedSessionCollector<{ id: string }> {
    return new ObservedSessionCollector<{ id: string }>({
      sources: [
        {
          providerId: 'p',
          discover: () => references().map((id) => ({ sessionId: id, fingerprintHint: '1:1' })),
          read: ({ sessionId }) => {
            reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
            return { id: sessionId };
          },
        },
      ],
      approximateValueBytes: () => 100,
      ...options,
    });
  }

  it('evicts the least recently observed entry once the entry bound is exceeded', async () => {
    const reads = new Map<string, number>();
    let ids = ['a', 'b'];
    const collector = boundedCollector({ maxCacheEntries: 2 }, () => ids, reads);
    await collector.collect();
    expect(collector.cacheSize).toBe(2);

    // A bounded pass never evicts sessions outside it, so only the LRU bound applies.
    ids = ['c'];
    await collector.collect({ limit: 10 });
    expect(collector.cacheSize).toBe(2);

    ids = ['a', 'b', 'c'];
    await collector.collect({ limit: 10 });
    expect(reads.get('a')).toBe(2);
    expect(reads.get('b')).toBe(1);
    expect(reads.get('c')).toBe(1);
  });

  it('evicts by approximate bytes but never within the pass that inserted an entry', async () => {
    const reads = new Map<string, number>();
    let ids = ['a', 'b', 'c'];
    const collector = boundedCollector({ maxCacheBytes: 250 }, () => ids, reads);
    await collector.collect();
    expect(collector.cacheSize).toBe(3);

    ids = ['d'];
    await collector.collect({ limit: 10 });
    expect(collector.cacheSize).toBe(2);
    ids = ['a', 'b', 'c', 'd'];
    await collector.collect({ limit: 10 });
    expect(reads.get('d')).toBe(1);
    expect(reads.get('c')).toBe(1);
    expect(reads.get('a')).toBe(2);
    expect(reads.get('b')).toBe(2);
  });
});
