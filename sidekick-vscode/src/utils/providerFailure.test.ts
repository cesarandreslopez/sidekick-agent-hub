import { describe, expect, it } from 'vitest';
import { ProviderRequestError, providerRetryOffer } from './providerFailure';

const codexError = (codexErrorInfo: unknown, extra: Record<string, unknown> = {}) =>
  new ProviderRequestError({
    provider: 'codex',
    credentialKind: 'oauth',
    error: new Error('Codex error: turn failed', {
      cause: { message: 'turn failed', codexErrorInfo, ...extra },
    }),
  });

describe('providerRetryOffer', () => {
  it('offers a retry for transient failures', () => {
    const offer = providerRetryOffer(codexError('serverOverloaded'));
    expect(offer).toEqual({ waitMs: 0, hint: '' });
  });

  it('carries the provider retry-after as a hint', () => {
    const offer = providerRetryOffer(
      codexError('usageLimitExceeded', { headers: { 'retry-after': '30' } }),
    );
    expect(offer).toEqual({ waitMs: 30_000, hint: ' The provider asked to wait 30s.' });
  });

  it('offers nothing when a retry cannot help', () => {
    expect(providerRetryOffer(codexError('unauthorized'))).toBeNull();
    expect(providerRetryOffer(codexError('contextWindowExceeded'))).toBeNull();
    expect(providerRetryOffer(codexError('modelNotFound'))).toBeNull();
    expect(providerRetryOffer(new Error('plain'))).toBeNull();
  });
});

describe('describeProviderFailure', () => {
  it('asks for another model when the model is unavailable', () => {
    const error = codexError('modelNotFound');
    expect(error.diagnosis).toMatchObject({
      diagnosis: 'model_unavailable',
      recovery: 'choose_model',
    });
    expect(error.message).toBe(
      "Codex model is unavailable or not enabled for this account. Choose another model in Sidekick's model settings.",
    );
  });
});
