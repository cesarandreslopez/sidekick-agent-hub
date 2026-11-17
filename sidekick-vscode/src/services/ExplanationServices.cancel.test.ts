/**
 * Cancellation contract for the explanation services: a cancel, or a declined
 * retry after a timeout the user already saw, rejects with the shared
 * AbortError-named error instead of a "Failed to generate…" failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => 'auto' }) },
}));
vi.mock('./TimeoutManager', () => ({
  TimeoutManager: class {},
  getTimeoutManager: () => ({
    getTimeoutConfig: () => ({
      baseTimeout: 30_000,
      maxTimeout: 120_000,
      perKbTimeout: 500,
      retryMultiplier: 1.5,
    }),
    executeWithTimeout: (...args: unknown[]) => mockExecuteWithTimeout(...args),
    promptRetry: vi.fn(),
  }),
}));

import { ExplanationService } from './ExplanationService';
import { ErrorExplanationService } from './ErrorExplanationService';

const authService = {
  getProviderId: () => 'claude-max',
  getProviderDisplayName: () => 'Claude Max',
  complete: vi.fn(),
};

const errorContext = {
  errorMessage: "Cannot find name 'foo'",
  errorCode: '2304',
  severity: 'error',
  fileName: '/w/a.ts',
  languageId: 'typescript',
  line: 1,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
} as never;

const cancelledResults = {
  'a toast cancel': {
    success: false,
    timedOut: false,
    cancelled: true,
    timeoutMs: 30_000,
    error: Object.assign(new Error('Request was cancelled'), { name: 'AbortError' }),
  },
  'a declined retry': { success: false, timedOut: true, retryDeclined: true, timeoutMs: 30_000 },
};

const calls = {
  explain: () => new ExplanationService(authService as never).explain('x', 'code', 'senior'),
  explainError: () =>
    new ErrorExplanationService(authService as never).explainError('x', errorContext),
  generateFix: () =>
    new ErrorExplanationService(authService as never).generateFix('x', errorContext),
};

describe('explanation services cancellation', () => {
  beforeEach(() => mockExecuteWithTimeout.mockReset());

  for (const [callName, call] of Object.entries(calls)) {
    for (const [caseName, result] of Object.entries(cancelledResults)) {
      it(`${callName} rejects with an AbortError for ${caseName}`, async () => {
        mockExecuteWithTimeout.mockResolvedValueOnce(result);
        await expect(call()).rejects.toMatchObject({
          name: 'AbortError',
          message: 'Request was cancelled',
        });
      });
    }

    it(`${callName} reports an undeclined timeout in seconds`, async () => {
      mockExecuteWithTimeout.mockResolvedValueOnce({
        success: false,
        timedOut: true,
        timeoutMs: 30_000,
      });
      await expect(call()).rejects.toThrow(/timed out after 30s$/);
    });
  }
});
