import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'config'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

import { ClaudeCodeProvider } from '../providers/claudeCode';
import {
  USAGE_CACHE_VERSION,
  collectUsageEvents,
  getUsageCacheDir,
  pruneUsageCache,
} from './usageEvents';

const MODEL = 'claude-sonnet-4-5-20250929';

function assistantRow(timestamp: string, input: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id: `msg-${timestamp}`,
      role: 'assistant',
      model: MODEL,
      usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: 40, ...extra },
      content: [{ type: 'text', text: 'ok' }],
    },
  };
}

function writeSession(rows: unknown[]): string {
  const dir = path.join(tmpDir, '.claude', 'projects', '-work-project');
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, 'session-usage.jsonl');
  fs.writeFileSync(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return sessionPath;
}

const BASE_ROWS = [
  {
    type: 'user',
    timestamp: '2026-09-04T12:00:00.000Z',
    cwd: '/work/project',
    message: { role: 'user', content: 'Hello' },
  },
  assistantRow('2026-09-04T12:00:05.000Z', 100),
  assistantRow('2026-09-04T12:30:05.000Z', 200, { reported_cost: 0.5 }),
];

describe('collectUsageEvents', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-events-'));
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads sessions once, prices events, and caches them by fingerprint', async () => {
    writeSession(BASE_ROWS);
    const first = await collectUsageEvents({ providers: [provider] });

    expect(first.cacheMisses).toBe(1);
    expect(first.cacheHits).toBe(0);
    expect(first.events).toHaveLength(2);
    expect(first.events[0]).toMatchObject({
      provider: 'claude-code',
      sessionId: 'session-usage',
      project: '/work/project',
      model: MODEL,
      timestamp: Date.parse('2026-09-04T12:00:05.000Z'),
      tokens: { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 40 },
      costProvenance: 'model-catalog',
    });
    expect(first.events[0].tokens.totalTokens).toBe(150);
    expect(first.events[0].costUsd).toBeGreaterThan(0);
    // A provider-reported cost is kept as reported, not re-estimated.
    expect(first.events[1]).toMatchObject({ costUsd: 0.5, costProvenance: 'provider-reported' });
    expect(first.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-usage',
        eventCount: 2,
        fromCache: false,
        firstTimestamp: Date.parse('2026-09-04T12:00:05.000Z'),
        lastTimestamp: Date.parse('2026-09-04T12:30:05.000Z'),
      }),
    ]);
    expect(fs.readdirSync(getUsageCacheDir())).toEqual(['claude-code--session-usage.json']);

    const createReader = vi.spyOn(provider, 'createReader');
    const second = await collectUsageEvents({ providers: [provider] });
    expect(createReader).not.toHaveBeenCalled();
    expect(second.cacheHits).toBe(1);
    expect(second.cacheMisses).toBe(0);
    expect(second.events).toEqual(first.events);
    expect(second.sessions[0].fromCache).toBe(true);
  });

  it('re-reads a session whose size or mtime changed', async () => {
    const sessionPath = writeSession(BASE_ROWS);
    await collectUsageEvents({ providers: [provider] });

    fs.appendFileSync(
      sessionPath,
      JSON.stringify(assistantRow('2026-09-04T13:00:05.000Z', 300)) + '\n',
    );
    const result = await collectUsageEvents({ providers: [provider] });

    expect(result.cacheMisses).toBe(1);
    expect(result.events).toHaveLength(3);
  });

  it('filters events by since and until on the event timestamp', async () => {
    writeSession(BASE_ROWS);
    const result = await collectUsageEvents({
      providers: [provider],
      since: '2026-09-04T12:10:00Z',
      until: '2026-09-04T13:00:00Z',
    });
    expect(result.events.map((event) => new Date(event.timestamp).toISOString())).toEqual([
      '2026-09-04T12:30:05.000Z',
    ]);
    expect(result.sessions[0].eventCount).toBe(1);

    await expect(collectUsageEvents({ providers: [provider], since: 'yesterday' })).rejects.toThrow(
      RangeError,
    );
  });

  it('skips the cache entirely with noCache', async () => {
    writeSession(BASE_ROWS);
    const result = await collectUsageEvents({ providers: [provider], noCache: true });
    expect(result.events).toHaveLength(2);
    expect(fs.existsSync(getUsageCacheDir())).toBe(false);
  });

  it('prunes the cache directory to the newest files', () => {
    const dir = path.join(tmpDir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const filePath = path.join(dir, `claude-code--s${index}.json`);
      fs.writeFileSync(filePath, '{}');
      const time = new Date(Date.UTC(2026, 8, 4, 12, index));
      fs.utimesSync(filePath, time, time);
    }
    expect(pruneUsageCache(2, dir)).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual(['claude-code--s3.json', 'claude-code--s4.json']);
  });

  it('counts each Claude response once when its split lines repeat the usage', async () => {
    const split = (output: number) => ({
      ...assistantRow('2026-09-04T12:00:05.000Z', 100),
      message: {
        ...assistantRow('2026-09-04T12:00:05.000Z', 100).message,
        id: 'msg-split',
        usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 40 },
      },
    });
    writeSession([BASE_ROWS[0], split(1), split(1), split(25)]);
    const result = await collectUsageEvents({ providers: [provider], noCache: true });
    expect(result.events).toHaveLength(1);
    // Last copy wins: 100 in + 40 cache read + 25 out, not three copies.
    expect(result.events[0].tokens.totalTokens).toBe(165);
  });

  it('adds Claude subagent transcripts to the parent session and fingerprints them', async () => {
    const sessionPath = writeSession(BASE_ROWS);
    const subDir = path.join(path.dirname(sessionPath), 'session-usage', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const agentPath = path.join(subDir, 'agent-a1.jsonl');
    const agentRow = {
      ...assistantRow('2026-09-04T12:10:00.000Z', 7),
      message: { ...assistantRow('2026-09-04T12:10:00.000Z', 7).message, id: 'msg-agent-1' },
      isSidechain: true,
    };
    fs.writeFileSync(agentPath, JSON.stringify(agentRow) + '\n');

    const first = await collectUsageEvents({ providers: [provider] });
    expect(first.events).toHaveLength(3);
    expect(first.events.every((event) => event.sessionId === 'session-usage')).toBe(true);
    expect(first.sessions[0].fingerprint).toContain('agent-a1.jsonl');

    const second = await collectUsageEvents({ providers: [provider] });
    expect(second.cacheHits).toBe(1);

    fs.appendFileSync(
      agentPath,
      JSON.stringify({
        ...agentRow,
        timestamp: '2026-09-04T12:11:00.000Z',
        message: { ...agentRow.message, id: 'msg-agent-2' },
      }) + '\n',
    );
    const third = await collectUsageEvents({ providers: [provider] });
    expect(third.cacheMisses).toBe(1);
    expect(third.events).toHaveLength(4);
  });

  it('rejects with AbortError before reading when the signal is already aborted', async () => {
    writeSession(BASE_ROWS);
    const createReader = vi.spyOn(provider, 'createReader');
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectUsageEvents({ providers: [provider], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createReader).not.toHaveBeenCalled();
    expect(fs.existsSync(getUsageCacheDir())).toBe(false);
  });

  it('stops between sessions on abort and caches only the sessions it finished', async () => {
    const sessionPath = writeSession(BASE_ROWS);
    fs.copyFileSync(sessionPath, path.join(path.dirname(sessionPath), 'session-other.jsonl'));
    const controller = new AbortController();
    const createReader = provider.createReader.bind(provider);
    const spy = vi.spyOn(provider, 'createReader').mockImplementation((filePath) => {
      controller.abort();
      return createReader(filePath);
    });

    await expect(
      collectUsageEvents({ providers: [provider], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(getUsageCacheDir())).toHaveLength(1);
  });

  it('re-reads cache files written by an older cache version', async () => {
    writeSession(BASE_ROWS);
    await collectUsageEvents({ providers: [provider] });
    const cacheFile = path.join(getUsageCacheDir(), 'claude-code--session-usage.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(cached.version).toBe(USAGE_CACHE_VERSION);
    fs.writeFileSync(cacheFile, JSON.stringify({ ...cached, version: 1 }));
    const result = await collectUsageEvents({ providers: [provider] });
    expect(result.cacheMisses).toBe(1);
  });
});
