import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installClosedPipeHandler } from './closedPipe';

function epipe(): NodeJS.ErrnoException {
  const err = new Error('write EPIPE') as NodeJS.ErrnoException;
  err.code = 'EPIPE';
  return err;
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('installClosedPipeHandler', () => {
  it('ends quietly with the current exit code when the reader closes stdout or stderr', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitProcess = vi.fn();
    const beforeExit = vi.fn();
    installClosedPipeHandler({ exit: true, beforeExit, exitProcess }, [stdout, stderr]);

    stderr.emit('error', epipe());
    expect(beforeExit).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);

    // A second write failing on the same closed pipe does not exit twice.
    stdout.emit('error', epipe());
    expect(exitProcess).toHaveBeenCalledOnce();
  });

  it('keeps a failed command failed', () => {
    const stdout = new EventEmitter();
    const exitProcess = vi.fn();
    process.exitCode = 1;
    installClosedPipeHandler({ exit: true, exitProcess }, [stdout]);
    stdout.emit('error', epipe());
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it('only swallows the error on the status-line path, so it can finish persisting', () => {
    const stdout = new EventEmitter();
    const exitProcess = vi.fn();
    installClosedPipeHandler({ exit: false, exitProcess }, [stdout]);
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('rethrows anything that is not a closed pipe', () => {
    const stdout = new EventEmitter();
    installClosedPipeHandler({ exit: true, exitProcess: vi.fn() }, [stdout]);
    const other = new Error('disk full') as NodeJS.ErrnoException;
    other.code = 'ENOSPC';
    expect(() => stdout.emit('error', other)).toThrow('disk full');
  });
});
