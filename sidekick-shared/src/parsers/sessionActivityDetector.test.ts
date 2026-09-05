import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  classifySessionActivity,
  detectSessionActivity,
  refreshSessionActivityState,
} from './sessionActivityDetector';

vi.mock('fs');
const mockFs = vi.mocked(fs);

function makeJsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function mockFileContent(content: string, mtimeMs: number) {
  const buffer = Buffer.from(content, 'utf-8');
  mockFs.statSync.mockReturnValue({
    size: buffer.length,
    mtimeMs,
  } as fs.Stats);
  mockFs.openSync.mockReturnValue(42);
  mockFs.readSync.mockImplementation((_fd, buf: ArrayBufferView) => {
    const target = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    buffer.copy(target, 0, 0, Math.min(buffer.length, target.length));
    return Math.min(buffer.length, target.length);
  });
  mockFs.closeSync.mockReturnValue(undefined);
}

describe('detectSessionActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ended for non-existent file', () => {
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = detectSessionActivity('/no/such/file.jsonl');
    expect(result.state).toBe('ended');
    expect(result.reason).toBe('file-not-found');
  });

  it('returns stale when mtime > 5 minutes ago', () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    mockFileContent(
      makeJsonlLine({ type: 'assistant', message: { role: 'assistant' } }),
      tenMinAgo,
    );
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('stale');
    expect(result.reason).toBe('mtime-stale');
  });

  it('returns ended for terminal result event', () => {
    const content = [
      makeJsonlLine({ type: 'assistant', message: { role: 'assistant', content: 'Done' } }),
      makeJsonlLine({ type: 'result', result: 'success' }),
    ].join('\n');
    mockFileContent(content, Date.now() - 1000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ended');
    expect(result.reason).toBe('terminal-event');
  });

  it('returns ongoing when AI activity after ending event', () => {
    const content = [
      makeJsonlLine({ type: 'user', message: { role: 'user', content: 'hello' } }),
      makeJsonlLine({ type: 'assistant', message: { role: 'assistant', content: 'thinking...' } }),
      makeJsonlLine({ type: 'tool_use', tool: { name: 'Read' } }),
    ].join('\n');
    mockFileContent(content, Date.now() - 1000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ongoing');
    expect(result.reason).toBe('ai-activity-after-ending');
  });

  it('returns ongoing during grace period after ending event', () => {
    const content = [
      makeJsonlLine({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }),
    ].join('\n');
    // Modified 2 seconds ago (within 5s grace)
    mockFileContent(content, Date.now() - 2000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ongoing');
    expect(result.reason).toBe('grace-period');
  });

  it('returns ended after grace period with ending event', () => {
    const content = [
      makeJsonlLine({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }),
    ].join('\n');
    // Modified 10 seconds ago (past 5s grace)
    mockFileContent(content, Date.now() - 10_000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ended');
    expect(result.reason).toBe('ending-event');
  });

  it('keeps a trailing user-carried tool result ongoing after the grace period', () => {
    const content = makeJsonlLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    });
    mockFileContent(content, Date.now() - 10_000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ongoing');
    expect(result.reason).toBe('ai-activity-after-ending');
  });

  it('returns ended for empty file', () => {
    mockFileContent('', Date.now() - 1000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ended');
    expect(result.reason).toBe('empty-file');
  });
});

describe('classifySessionActivity', () => {
  const NOW = Date.parse('2026-09-04T12:00:00Z');
  const event = (type: string, extra: Record<string, unknown> = {}, offsetMs = 0) =>
    ({
      type,
      timestamp: new Date(NOW - 60_000 + offsetMs).toISOString(),
      message: { role: type === 'user' ? 'user' : 'assistant', ...extra },
    }) as never;

  it('is stale when the source mtime is older than five minutes', () => {
    const result = classifySessionActivity({
      events: [event('assistant')],
      mtimeMs: NOW - 10 * 60_000,
      now: NOW,
    });
    expect(result).toMatchObject({ state: 'stale', reason: 'mtime-stale' });
  });

  it('is ongoing when AI activity follows the last ending event', () => {
    const result = classifySessionActivity({
      events: [
        event('user', { content: 'hello' }),
        event('assistant', { content: 'thinking' }),
        event('tool_use'),
      ],
      mtimeMs: NOW - 1000,
      now: NOW,
    });
    expect(result).toMatchObject({ state: 'ongoing', reason: 'ai-activity-after-ending' });
  });

  it('treats an end_turn assistant message as an ending event with a grace period', () => {
    const events = [
      event('user', { content: 'hi' }),
      event('assistant', { stop_reason: 'end_turn' }),
    ];
    expect(classifySessionActivity({ events, mtimeMs: NOW - 2000, now: NOW })).toMatchObject({
      state: 'ongoing',
      reason: 'grace-period',
    });
    expect(classifySessionActivity({ events, mtimeMs: NOW - 10_000, now: NOW })).toMatchObject({
      state: 'ended',
      reason: 'ending-event',
    });
  });

  it('counts a user event carrying tool results as AI activity, not an ending', () => {
    const result = classifySessionActivity({
      events: [
        event('assistant', { stop_reason: 'tool_use' }),
        event('user', { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }),
      ],
      mtimeMs: NOW - 10_000,
      now: NOW,
    });
    expect(result).toMatchObject({ state: 'ongoing', reason: 'ai-activity-after-ending' });
  });

  it('falls back to the last event timestamp when the mtime is unknown', () => {
    const result = classifySessionActivity({
      events: [event('user', { content: 'hi' }), event('assistant', {}, 30_000)],
      mtimeMs: null,
      now: NOW,
    });
    expect(result.state).toBe('ongoing');
    expect(result.lastActivityTime?.toISOString()).toBe(new Date(NOW - 30_000).toISOString());
    expect(classifySessionActivity({ events: [], mtimeMs: null, now: NOW })).toMatchObject({
      state: 'ended',
      reason: 'no-events',
    });
  });
});

describe('refreshSessionActivityState', () => {
  const NOW = Date.parse('2026-09-04T12:00:00Z');

  it('keeps a genuinely active session active until the staleness boundary', () => {
    expect(
      refreshSessionActivityState('active', NOW - 60_000, NOW, 'ai-activity-after-ending'),
    ).toBe('active');
    expect(
      refreshSessionActivityState('active', NOW - 6 * 60_000, NOW, 'ai-activity-after-ending'),
    ).toBe('idle');
  });

  it('ends a session that was active only by grace period once the grace period lapses', () => {
    expect(refreshSessionActivityState('active', NOW - 2000, NOW, 'grace-period')).toBe('active');
    expect(refreshSessionActivityState('active', NOW - 6000, NOW, 'grace-period')).toBe('ended');
    expect(refreshSessionActivityState('active', NOW - 6000, NOW, 'recent-mtime')).toBe('ended');
    // Without a reason the previous behaviour stands.
    expect(refreshSessionActivityState('active', NOW - 6000, NOW)).toBe('active');
  });
});
