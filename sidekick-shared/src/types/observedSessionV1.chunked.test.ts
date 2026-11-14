/**
 * The observed-session adapter reads a session in bounded steps (yielding
 * between them), discovers sessions one at a time, and never starts a
 * second watch read while one is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'config'),
}));

import { ClaudeCodeProvider } from '../providers/claudeCode';
import { computeSessionFileStats } from '../sessionStats';
import { createProviderSessionAdapterV1 } from './observedSessionV1';
import type { ObservedAgentSessionV1 } from './observedSessionV1';

const MODEL = 'claude-sonnet-4-5-20250929';

function bigSession(name: string, fillerLines: number): string {
  const dir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const rows: unknown[] = [
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:00.000Z',
      message: { role: 'user', content: 'Go' },
    },
  ];
  for (let i = 0; i < fillerLines; i++) {
    rows.push({
      type: 'system',
      subtype: 'filler',
      timestamp: '2026-09-04T12:00:01.000Z',
      content: 'f'.repeat(50_000),
    });
  }
  rows.push({
    type: 'assistant',
    timestamp: '2026-09-04T12:00:05.000Z',
    message: {
      id: 'msg-1',
      role: 'assistant',
      model: MODEL,
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
      content: [{ type: 'text', text: 'Done.' }],
    },
  });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  return file;
}

describe('createProviderSessionAdapterV1 bounded reads', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-observed-chunked-'));
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a multi-MiB session in steps, yielding between them, with the same usage', async () => {
    const file = bigSession('big', 60); // ~3 MB: several 1 MiB steps
    const adapter = createProviderSessionAdapterV1(provider);
    let turns = 0;
    let pending = true;
    const tick = () => {
      if (!pending) return;
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const session = await adapter.read(file, '/work');
    pending = false;

    expect(turns).toBeGreaterThan(1);
    const events = provider.createReader(file).readAll();
    const stats = computeSessionFileStats(events, {
      providerId: 'claude-code',
      sessionId: 'big',
      filePath: file,
    });
    expect(session.usage.inputTokens.value).toBe(stats.tokens.input);
    expect(session.usage.cacheReadTokens.value).toBe(40);
    expect(session.model.value).toBe(MODEL);
    expect(session.activity.value).toBe('ended');
  });

  it('discovers sessions one at a time', async () => {
    const files = [bigSession('a', 1), bigSession('b', 1), bigSession('c', 1)];
    vi.spyOn(provider, 'findAllSessions').mockReturnValue(files);
    const adapter = createProviderSessionAdapterV1(provider);
    const read = adapter.read.bind(adapter);
    let active = 0;
    let peak = 0;
    adapter.read = async (sessionPath, cwd) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await read(sessionPath, cwd);
      } finally {
        active -= 1;
      }
    };
    const sessions = await adapter.discover('/work');
    expect(sessions.map((session) => session.identity.sessionId)).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
  });

  it('keeps discovering past a session that cannot be read', async () => {
    const files = [bigSession('a', 1), bigSession('bad', 1), bigSession('c', 1)];
    vi.spyOn(provider, 'findAllSessions').mockReturnValue(files);
    const create = provider.createReader.bind(provider);
    vi.spyOn(provider, 'createReader').mockImplementation((sessionPath, options) => {
      const reader = create(sessionPath, options);
      if (sessionPath.endsWith('bad.jsonl')) {
        reader.readNewBounded = () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        };
      }
      return reader;
    });
    const adapter = createProviderSessionAdapterV1(provider);
    const sessions = await adapter.discover('/work');
    expect(sessions.map((session) => session.identity.sessionId)).toEqual(['a', 'bad', 'c']);
  });

  it('skips watch polls while a read is still in flight', async () => {
    const file = bigSession('w', 1);
    const adapter = createProviderSessionAdapterV1(provider, { pollIntervalMs: 5 });
    const read = adapter.read.bind(adapter);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.read = async (sessionPath, cwd) => {
      calls += 1;
      await gate;
      return read(sessionPath, cwd);
    };
    const seen: ObservedAgentSessionV1[] = [];
    const handle = adapter.watch!(file, (session) => seen.push(session), '/work');
    // Many poll intervals pass while the first read is held.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    handle.dispose();
    expect(seen).toHaveLength(1);
    // Later polls found the fingerprint unchanged and did not read again.
    expect(calls).toBe(1);
  });
});
