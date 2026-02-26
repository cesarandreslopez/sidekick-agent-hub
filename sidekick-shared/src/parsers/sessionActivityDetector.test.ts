import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { detectSessionActivity } from './sessionActivityDetector';

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
    mockFs.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
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

  it('returns ended for empty file', () => {
    mockFileContent('', Date.now() - 1000);
    const result = detectSessionActivity('/session.jsonl');
    expect(result.state).toBe('ended');
    expect(result.reason).toBe('empty-file');
  });
});
