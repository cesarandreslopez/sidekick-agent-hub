import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'config'),
}));

import { observedSessionSourceFromProvider } from '../observedSessionCollector';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { createProviderSessionAdapterV1, getObservedActivityReason } from './observedSessionV1';

const MODEL = 'claude-sonnet-4-5-20250929';

function rows(endTurn: boolean) {
  return [
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:00.000Z',
      message: { role: 'user', content: 'Refactor the parser' },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-04T12:00:05.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: MODEL,
        ...(endTurn ? { stop_reason: 'end_turn' } : {}),
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ];
}

function writeSession(content: unknown[], mtime: Date): string {
  const dir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, 'session-v1.jsonl');
  fs.writeFileSync(sessionPath, content.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.utimesSync(sessionPath, mtime, mtime);
  return sessionPath;
}

describe('createProviderSessionAdapterV1', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-observed-v1-'));
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
    provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a session once: one flushed reader, no separate stats or tail read', async () => {
    const sessionPath = writeSession(rows(false), new Date(Date.now() - 60_000));
    const readSessionStats = vi.spyOn(provider, 'readSessionStats');
    const createReader = vi.spyOn(provider, 'createReader');
    let flushes = 0;
    createReader.mockImplementation((p: string) => {
      const reader = new ClaudeCodeProvider().createReader(p);
      const flush = reader.flush.bind(reader);
      reader.flush = () => {
        flushes += 1;
        flush();
      };
      return reader;
    });
    const adapter = createProviderSessionAdapterV1(provider);

    const session = await adapter.read(sessionPath, '/work');

    expect(createReader).toHaveBeenCalledTimes(1);
    expect(flushes).toBe(1);
    expect(readSessionStats).not.toHaveBeenCalled();
    expect(session.identity.sessionId).toBe('session-v1');
    expect(session.model.value).toBe(MODEL);
    expect(session.usage.inputTokens.value).toBe(100);
    expect(session.usage.cacheReadTokens.value).toBe(40);
    expect(session.usage.normalized?.value.totalTokens).toBe(150);
    expect(session.usage.costUsd.value).toBeGreaterThan(0);
    // Last event is an assistant turn without end_turn: AI activity, within staleness.
    expect(session.activity.value).toBe('active');
    expect(getObservedActivityReason(session)).toBe('ai-activity-after-ending');
  });

  it('classifies an ended turn from events and marks a stale file idle', async () => {
    const ended = writeSession(rows(true), new Date(Date.now() - 60_000));
    const adapter = createProviderSessionAdapterV1(provider);
    const session = await adapter.read(ended);
    expect(session.activity.value).toBe('ended');
    expect(getObservedActivityReason(session)).toBe('ending-event');

    const stale = writeSession(rows(false), new Date(Date.now() - 10 * 60_000));
    expect((await adapter.read(stale)).activity.value).toBe('idle');
  });

  it('watches without re-reading while the fingerprint is unchanged and refreshes activity in place', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    // Written two seconds ago with an end_turn: active only by grace period.
    const sessionPath = writeSession(rows(true), new Date(Date.now() - 2000));
    const createReader = vi.spyOn(provider, 'createReader');
    const adapter = createProviderSessionAdapterV1(provider, { pollIntervalMs: 1000 });
    const seen: string[] = [];

    const subscription = adapter.watch(sessionPath, (session) => seen.push(session.activity.value));
    await vi.advanceTimersByTimeAsync(10);
    expect(createReader).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['active']);

    // Two more ticks with the same size and mtime: no reads, no emissions.
    await vi.advanceTimersByTimeAsync(2000);
    expect(createReader).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['active']);

    // Once the grace period lapses the cached classification flips to ended, still without a read.
    await vi.advanceTimersByTimeAsync(4000);
    expect(createReader).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['active', 'ended']);

    // New content re-reads.
    fs.appendFileSync(
      sessionPath,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg-2',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: 'more' }],
        },
      }) + '\n',
    );
    const touched = new Date(Date.now());
    fs.utimesSync(sessionPath, touched, touched);
    await vi.advanceTimersByTimeAsync(1000);
    expect(createReader).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['active', 'ended', 'active']);

    subscription.dispose();
  });

  it('lets the collector refresh a grace-period active session to ended from its cached reason', async () => {
    const sessionPath = writeSession(rows(true), new Date(Date.now() - 2000));
    const source = observedSessionSourceFromProvider(provider, '/work');
    const reference = { sessionId: 'session-v1', sourceKey: sessionPath };
    const cached = await source.read(reference);
    expect(cached.activity.value).toBe('active');
    expect(getObservedActivityReason(cached)).toBe('grace-period');

    const refreshed = source.refreshCached!(
      { ...reference, fingerprintParts: { sizeBytes: 1, mtimeMs: Date.now() - 6000 } },
      cached,
      new Date().toISOString(),
    );
    expect(refreshed.activity.value).toBe('ended');
    source.dispose?.();
  });
});
