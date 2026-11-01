import { describe, expect, it } from 'vitest';
import { diagnoseProviderFailure } from 'sidekick-shared';
import { describeInferenceFailure } from './providerFailure';

describe('describeInferenceFailure retry wording', () => {
  it('does not suggest retrying an exhausted usage quota with no known reset', () => {
    const diagnosis = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: { codexErrorInfo: 'usageLimitExceeded', message: 'usage limit reached' },
    });
    expect(diagnosis).toMatchObject({ recovery: 'retry_later', retryable: false });
    const text = describeInferenceFailure(diagnosis);
    expect(text).toContain('Codex usage limit is exhausted');
    expect(text).not.toMatch(/retry/i);
  });

  it('keeps the retry advice, with the provider delay, when the failure is retryable', () => {
    const limited = diagnoseProviderFailure({
      provider: 'claude-code',
      credentialKind: 'api-key',
      error: Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': '300' },
      }),
    });
    expect(limited.retryable).toBe(true);
    expect(describeInferenceFailure(limited)).toBe(
      'Claude is rate limited or overloaded. Retry in 5m.',
    );

    const overloaded = diagnoseProviderFailure({
      provider: 'claude-code',
      credentialKind: 'api-key',
      error: Object.assign(new Error('overloaded'), { status: 529 }),
    });
    expect(describeInferenceFailure(overloaded)).toBe(
      'Claude is rate limited or overloaded. Wait before retrying.',
    );
    // A diagnosis stored before `retryable` existed reads as before.
    const { retryable: _retryable, ...legacy } = overloaded;
    expect(describeInferenceFailure(legacy)).toBe(describeInferenceFailure(overloaded));
  });
});
