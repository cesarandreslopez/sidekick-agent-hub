import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SessionProviderBase } from 'sidekick-shared';
import {
  createDashboardSignalHandler,
  createTuiFatalGuard,
  formatFatalError,
  installTuiFatalHandlers,
  selectSessionProvider,
  signalExitCode,
} from './dashboardLifecycle';

function provider(id: SessionProviderBase['id']): SessionProviderBase {
  return { id, dispose: vi.fn() } as unknown as SessionProviderBase;
}

describe('dashboard lifecycle', () => {
  it('reuses the selected additional provider and disposes the original', () => {
    const original = provider('claude-code');
    const codex = provider('codex');
    const create = vi.fn();
    expect(selectSessionProvider(original, [codex], 'codex', create)).toBe(codex);
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans up, unmounts Ink, and exits on a process signal', () => {
    const cleanup = vi.fn();
    const unmount = vi.fn();
    const exit = vi.fn();
    createDashboardSignalHandler(cleanup, unmount, exit)();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 128 plus the signal number, so scripts see the kill', () => {
    const exit = vi.fn();
    const handler = createDashboardSignalHandler(vi.fn(), vi.fn(), exit);
    handler('SIGTERM');
    handler('SIGHUP');
    handler('SIGQUIT');
    expect(exit.mock.calls.map(([code]) => code)).toEqual([143, 129, 131]);
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode(undefined)).toBe(0);
  });
});

describe('installTuiFatalHandlers', () => {
  function setup() {
    const target = new EventEmitter();
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    const dispose = installTuiFatalHandlers({
      teardown: () => order.push('teardown'),
      write: (text, done) => {
        order.push(`write ${text.split('\n')[0]}`);
        done();
      },
      exitProcess: exit,
      target: target as unknown as Pick<NodeJS.Process, 'on' | 'removeListener'>,
    });
    return { target, order, exit, dispose };
  }

  it('tears down before printing, then exits 1 once the message is flushed', () => {
    const { target, order } = setup();
    target.emit('uncaughtException', new Error('watcher exploded'));
    expect(order).toEqual(['teardown', 'write Error: watcher exploded', 'exit 1']);
  });

  it('handles an unhandled rejection the same way, and only once', () => {
    const { target, order } = setup();
    target.emit('unhandledRejection', 'no reason');
    target.emit('uncaughtException', new Error('second'));
    expect(order).toEqual(['teardown', 'write Unexpected error: no reason', 'exit 1']);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });

  it('removes its listeners when disposed', () => {
    const { target, dispose } = setup();
    expect(target.listenerCount('uncaughtException')).toBe(1);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    dispose();
    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });

  it('a fatal teardown followed by Ink resolving its wait exits only with 1', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const pendingWrites: Array<() => void> = [];
    const guard = createTuiFatalGuard({
      teardown: () => {},
      // The flush callback runs later, as it may on Windows.
      write: (_text, done) => pendingWrites.push(done),
      exitProcess: exit,
      target: target as unknown as Pick<NodeJS.Process, 'on' | 'removeListener'>,
    });
    target.emit('uncaughtException', new Error('boom'));
    // The teardown unmounted Ink, so the code after waitUntilExit now runs.
    guard.finish(() => exit(0));
    for (const done of pendingWrites) done();
    expect(exit.mock.calls).toEqual([[1]]);
    expect(guard.fatal).toBe(true);
  });

  it('runs the normal exit when nothing failed, and stops listening first', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const guard = createTuiFatalGuard({
      teardown: () => {},
      write: (_text, done) => done(),
      exitProcess: exit,
      target: target as unknown as Pick<NodeJS.Process, 'on' | 'removeListener'>,
    });
    guard.finish(() => exit(0));
    expect(exit.mock.calls).toEqual([[0]]);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });

  it('fail() and an uncaught error together take the fatal path once', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const teardown = vi.fn();
    const guard = createTuiFatalGuard({
      teardown,
      write: (_text, done) => done(),
      exitProcess: exit,
      target: target as unknown as Pick<NodeJS.Process, 'on' | 'removeListener'>,
    });
    guard.fail(new Error('render failed'));
    target.emit('uncaughtException', new Error('again'));
    expect(teardown).toHaveBeenCalledOnce();
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('prints the stack, not only the message', () => {
    const error = new Error('boom');
    expect(formatFatalError(error)).toContain('dashboardLifecycle.test');
  });
});
