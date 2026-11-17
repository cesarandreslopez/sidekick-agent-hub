import { describe, expect, it } from 'vitest';
import { cancellationError, isCancellationError, toErrorMessage } from './errors';

describe('toErrorMessage', () => {
  it('uses the message from an Error', () => {
    // Interpolating the Error directly yields "Error: ENOENT..." in a toast.
    expect(toErrorMessage(new Error('ENOENT: no such file'))).toBe('ENOENT: no such file');
  });

  it('falls back for an Error with no message', () => {
    expect(toErrorMessage(new Error(''))).toBe('Unknown error');
    expect(toErrorMessage(new Error('   '))).toBe('Unknown error');
  });

  it('passes a plain string through', () => {
    expect(toErrorMessage('disk full')).toBe('disk full');
  });

  it('falls back for a blank string', () => {
    expect(toErrorMessage('   ')).toBe('Unknown error');
  });

  it.each([null, undefined, {}, []])('falls back for %p', (value) => {
    // String({}) is "[object Object]", which tells a user nothing.
    expect(toErrorMessage(value)).toBe('Unknown error');
  });

  it('reads a message off an error-shaped object', () => {
    expect(toErrorMessage({ message: 'rejected by remote' })).toBe('rejected by remote');
  });

  it('renders primitives that carry information', () => {
    expect(toErrorMessage(404)).toBe('404');
    expect(toErrorMessage(false)).toBe('false');
  });

  it('honors a caller-supplied fallback', () => {
    expect(toErrorMessage(null, 'Could not open the session')).toBe('Could not open the session');
  });
});

describe('cancellation errors', () => {
  it('names the error AbortError so existing name checks keep working', () => {
    const err = cancellationError();
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('Request was cancelled');
    expect(isCancellationError(err)).toBe(true);
  });

  it('recognises any AbortError-named error, and nothing else', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isCancellationError(abort)).toBe(true);
    // The Anthropic SDKs' abort errors keep the default name.
    expect(isCancellationError(new Error('Claude Code process aborted by user'))).toBe(false);
    expect(isCancellationError('AbortError')).toBe(false);
    expect(isCancellationError(undefined)).toBe(false);
  });
});
