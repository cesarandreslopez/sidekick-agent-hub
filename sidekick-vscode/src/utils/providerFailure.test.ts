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
    expect(providerRetryOffer(new Error('plain'))).toBeNull();
  });
});
