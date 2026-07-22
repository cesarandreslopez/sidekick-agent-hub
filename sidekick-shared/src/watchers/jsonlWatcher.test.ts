import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const watchMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn(() => ({ size: 0 })));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, watch: watchMock, statSync: statMock };
});

import { JsonlSessionWatcher } from './jsonlWatcher';

afterEach(() => {
  vi.useRealTimers();
  watchMock.mockReset();
});

describe('JsonlSessionWatcher', () => {
  it('reports fs.watch errors and keeps catch-up polling active', () => {
    vi.useFakeTimers();
    const fsWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchMock.mockReturnValue(fsWatcher);
    const onError = vi.fn();
    const watcher = new JsonlSessionWatcher('claude-code', '/session.jsonl', {
      onEvent: vi.fn(),
      onError,
    });
    watcher.start(false);
    const error = new Error('watch limit reached');
    fsWatcher.emit('error', error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(fsWatcher.close).toHaveBeenCalledOnce();
    expect(watcher.isActive).toBe(true);
    watcher.stop();
  });
});
