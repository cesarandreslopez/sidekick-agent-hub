import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { SessionMonitor } from './sessionMonitor';
import type { SessionProviderBase, SessionReader } from './providers/types';

describe('SessionMonitor subscriptions', () => {
  it('auto-polls after a fingerprint change when filesystem watching is unavailable', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sidekick-monitor-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    writeFileSync(sessionPath, '{}\n');
    const reader: SessionReader = {
      readNew: vi.fn(() => []),
      readAll: vi.fn(() => []),
      reset: vi.fn(),
      exists: vi.fn(() => true),
      flush: vi.fn(),
      getPosition: vi.fn(() => 0),
      seekTo: vi.fn(),
      wasTruncated: vi.fn(() => false),
    };
    const provider = {
      id: 'claude-code',
      displayName: 'Claude Code',
      createReader: () => reader,
      getSessionId: () => 'session',
      getProjectsBaseDir: () => path.join(directory, 'missing-watch-root'),
      dispose: vi.fn(),
    } as unknown as SessionProviderBase;
    const monitor = new SessionMonitor(provider);
    monitor.attach(sessionPath);
    const subscription = monitor.subscribe({ debounceMs: 0, pollIntervalMs: 5 });

    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const before = vi.mocked(reader.readNew).mock.calls.length;
      writeFileSync(sessionPath, '{}\n{}\n');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(vi.mocked(reader.readNew).mock.calls.length).toBeGreaterThan(before);
    } finally {
      subscription.dispose();
      monitor.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refreshes synthetic DB fingerprints asynchronously during catch-up polls', async () => {
    let mtimeMs = 1;
    const reader: SessionReader = {
      readNew: vi.fn(() => []),
      readAll: vi.fn(() => []),
      reset: vi.fn(),
      exists: vi.fn(() => true),
      flush: vi.fn(),
      getPosition: vi.fn(() => 0),
      seekTo: vi.fn(),
      wasTruncated: vi.fn(() => false),
    };
    const provider = {
      id: 'opencode',
      displayName: 'OpenCode',
      createReader: () => reader,
      getSessionId: () => 'session',
      getSessionMetadataAsync: vi.fn(async () => ({ mtime: new Date(mtimeMs) })),
      getProjectsBaseDir: () => '/missing-opencode-watch-root',
      dispose: vi.fn(),
    } as unknown as SessionProviderBase;
    const monitor = new SessionMonitor(provider);
    monitor.attach('/synthetic/opencode/session.json');
    const subscription = monitor.subscribe({ debounceMs: 0, pollIntervalMs: 5 });

    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const before = vi.mocked(reader.readNew).mock.calls.length;
      mtimeMs = 2;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(provider.getSessionMetadataAsync)).toHaveBeenCalled();
      expect(vi.mocked(reader.readNew).mock.calls.length).toBeGreaterThan(before);
    } finally {
      subscription.dispose();
      monitor.dispose();
    }
  });
});

describe('SessionMonitor.poll after the file starts over', () => {
  const block = (id: string, output: number, text: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-01T12:00:00Z',
      message: {
        id,
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500 },
      },
    }) + '\n';
  const session =
    block('msg_1', 4, 'thinking') + block('msg_1', 323, 'done') + block('msg_2', 7, 'ok');

  it.each([
    ['truncated', (file: string) => writeFileSync(file, block('msg_1', 4, 'thinking'))],
    [
      'rewritten',
      (file: string) => {
        writeFileSync(file, session.replace('thinking', 'THINKING'));
        utimesSync(file, new Date(), new Date(Date.now() + 5_000));
      },
    ],
    [
      'replaced',
      (file: string) => {
        writeFileSync(`${file}.next`, session + block('msg_3', 9, 'more'));
        renameSync(`${file}.next`, file);
      },
    ],
  ])('resets the aggregate in the same poll (%s) and matches a fresh attach', (_reason, change) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sidekick-monitor-reset-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    writeFileSync(sessionPath, session);
    const monitor = new SessionMonitor(new ClaudeCodeProvider());
    const fresh = new SessionMonitor(new ClaudeCodeProvider());
    try {
      expect(monitor.attach(sessionPath).tokens.outputTokens).toBe(323 + 7);
      change(sessionPath);
      expect(monitor.poll().length).toBeGreaterThan(0);
      const expected = fresh.attach(sessionPath).tokens;
      expect(monitor.getMetrics().tokens).toEqual(expected);
      // A later poll has nothing to add and leaves the totals alone.
      expect(monitor.poll()).toEqual([]);
      expect(monitor.getMetrics().tokens).toEqual(expected);
    } finally {
      monitor.dispose();
      fresh.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
