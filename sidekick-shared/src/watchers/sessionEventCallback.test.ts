import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionProviderBase, SessionReader } from '../providers/types';
import type { SessionEvent } from '../types/sessionEvent';
import { JsonlSessionWatcher } from './jsonlWatcher';
import { ProviderReaderSessionWatcher } from './providerReaderWatcher';
import type { FollowEvent } from './types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-events-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('onSessionEvent', () => {
  it('JSONL watcher (Claude Code): every event during replay, before its follow events', async () => {
    const file = tempFile([
      { type: 'user', timestamp: at(1), message: { role: 'user', content: 'go' } },
      {
        type: 'attachment',
        timestamp: at(2),
        attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', durationMs: 5 },
      },
      {
        type: 'assistant',
        timestamp: at(3),
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const order: string[] = [];
    const sessionEvents: SessionEvent[] = [];
    const watcher = new JsonlSessionWatcher(
      'claude-code',
      file,
      {
        onEvent: (event: FollowEvent) => order.push(`follow:${event.type}`),
        onSessionEvent: (event) => {
          sessionEvents.push(event);
          order.push(`session:${event.type}`);
        },
      },
      { includeActivitySignals: true },
    );
    watcher.start(true);
    await settle();
    watcher.stop();
    expect(sessionEvents.map((event) => event.type)).toEqual(['user', 'system', 'assistant']);
    expect(sessionEvents[1].origin?.kind).toBe('hook');
    expect(order[0]).toBe('session:user');
    expect(order.indexOf('session:assistant')).toBeLessThan(order.indexOf('follow:assistant'));
  });

  it('JSONL watcher: no activity signals unless asked', async () => {
    const file = tempFile([
      {
        type: 'attachment',
        timestamp: at(2),
        attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop' },
      },
    ]);
    const sessionEvents: SessionEvent[] = [];
    const watcher = new JsonlSessionWatcher('claude-code', file, {
      onEvent: () => undefined,
      onSessionEvent: (event) => sessionEvents.push(event),
    });
    watcher.start(true);
    await settle();
    watcher.stop();
    expect(sessionEvents).toEqual([]);
  });

  it('provider reader watcher (Codex): events come from the reader, before follow events', async () => {
    const file = tempFile([]);
    const events: SessionEvent[] = [
      { type: 'user', timestamp: at(1), message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        timestamp: at(2),
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
    ];
    let options: unknown;
    const reader: SessionReader = {
      readNew: () => events.splice(0),
      readAll: () => [],
      reset: () => undefined,
      exists: () => true,
      flush: () => undefined,
      getPosition: () => 0,
      seekTo: () => undefined,
      wasTruncated: () => false,
    };
    const provider = {
      id: 'codex',
      createReader: (_path: string, readerOptions?: unknown) => {
        options = readerOptions;
        return reader;
      },
    } as unknown as SessionProviderBase;
    const order: string[] = [];
    const watcher = new ProviderReaderSessionWatcher(
      provider,
      file,
      {
        onEvent: (event) => order.push(`follow:${event.type}`),
        onSessionEvent: (event) => order.push(`session:${event.type}`),
      },
      { includeActivitySignals: true },
    );
    watcher.start(true);
    await settle();
    watcher.stop();
    expect(options).toEqual({ includeActivitySignals: true });
    expect(order[0]).toBe('session:user');
    expect(order.indexOf('session:assistant')).toBeLessThan(order.indexOf('follow:assistant'));
  });
});
