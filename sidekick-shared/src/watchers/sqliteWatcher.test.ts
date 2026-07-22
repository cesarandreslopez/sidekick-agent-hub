import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  parts: [] as Array<Record<string, unknown>>,
  messageQueries: 0,
  partQueries: 0,
}));

vi.mock('../providers/openCodeDatabase', () => ({
  OpenCodeDatabase: class {
    isAvailable() {
      return true;
    }
    open() {
      return true;
    }
    close() {}
    getMessagesNewerThan(_sessionId: string, after: number) {
      dbState.messageQueries++;
      return dbState.messages.filter((row) => Number(row.time_updated) > after);
    }
    getPartsNewerThan(_sessionId: string, after: number) {
      dbState.partQueries++;
      return dbState.parts.filter((row) => Number(row.time_updated) > after);
    }
    getLatestMessageTimeUpdated() {
      return 0;
    }
    getLatestPartTimeUpdated() {
      return 0;
    }
  },
}));

import { SqliteSessionWatcher } from './sqliteWatcher';

afterEach(() => {
  vi.useRealTimers();
  dbState.messages = [];
  dbState.parts = [];
  dbState.messageQueries = 0;
  dbState.partQueries = 0;
});

describe('SqliteSessionWatcher', () => {
  it('uses incremental update cursors and re-emits an in-place tool result', async () => {
    vi.useFakeTimers();
    dbState.parts = [
      {
        id: 'part-1',
        message_id: 'message-1',
        session_id: 'session-1',
        time_created: 100,
        time_updated: 100,
        data: JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'running' } }),
      },
    ];
    const events: Array<{ type: string }> = [];
    const watcher = new SqliteSessionWatcher('/missing/opencode.db', 'session-1', {
      onEvent: (event) => events.push(event),
    });
    watcher.start(true);
    expect(events.map((event) => event.type)).toEqual(['tool_use']);

    dbState.parts = [
      {
        ...dbState.parts[0],
        time_updated: 101,
        data: JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'result' } }),
      },
      {
        id: 'part-2',
        message_id: 'message-1',
        session_id: 'session-1',
        time_created: 100,
        time_updated: 101,
        data: JSON.stringify({ type: 'text', text: 'same millisecond' }),
      },
    ];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(watcher.getPosition()).toBe(101);
    expect(dbState.messageQueries).toBe(2);
    expect(dbState.partQueries).toBe(2);
    watcher.stop();
  });
});
