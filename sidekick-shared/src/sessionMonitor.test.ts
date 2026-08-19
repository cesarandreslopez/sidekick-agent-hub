import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
