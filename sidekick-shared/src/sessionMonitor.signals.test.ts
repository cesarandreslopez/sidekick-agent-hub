import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionProviderBase, SessionReader } from './providers/types';

const fsMocks = vi.hoisted(() => ({
  watch: vi.fn(),
  statCalls: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: fsMocks.watch,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      fsMocks.statCalls.push(String(args[0]));
      return (actual.statSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.statSync,
  };
});

import { SessionMonitor } from './sessionMonitor';

describe('SessionMonitor watch signals', () => {
  afterEach(() => {
    fsMocks.watch.mockReset();
    fsMocks.statCalls.length = 0;
  });

  it('costs nothing for another file and one stat for the attached session', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sidekick-monitor-signals-'));
    const root = path.join(directory, 'projects');
    const projectDir = path.join(root, 'proj');
    const sessionPath = path.join(projectDir, 'session.jsonl');
    mkdirSync(projectDir, { recursive: true });
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
      getProjectsBaseDir: () => root,
      dispose: vi.fn(),
    } as unknown as SessionProviderBase;
    let emitEvent: ((eventType: string, filename: string | null) => void) | undefined;
    fsMocks.watch.mockImplementation((_root, _options, listener) => {
      emitEvent = listener;
      return Object.assign(new EventEmitter(), { close: vi.fn() });
    });
    const monitor = new SessionMonitor(provider);
    monitor.attach(sessionPath);
    const subscription = monitor.subscribe({ debounceMs: 0, pollIntervalMs: 0 });

    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(emitEvent).toBeDefined();
      fsMocks.statCalls.length = 0;
      const before = vi.mocked(reader.readNew).mock.calls.length;

      emitEvent?.('change', path.join('proj', 'other.jsonl'));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(fsMocks.statCalls).toEqual([]);
      expect(vi.mocked(reader.readNew).mock.calls.length).toBe(before);

      writeFileSync(sessionPath, '{}\n{}\n');
      emitEvent?.('change', path.join('proj', 'session.jsonl'));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(fsMocks.statCalls).toEqual([sessionPath]);
      expect(vi.mocked(reader.readNew).mock.calls.length).toBeGreaterThan(before);
    } finally {
      subscription.dispose();
      monitor.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
