import { describe, expect, it, vi } from 'vitest';
import {
  diagnoseProviderFailure,
  type ProviderAuthenticationEvidence,
  type ProviderCredentialKind,
  type ProviderFailureCode,
} from './providerFailure';
import { ACCOUNT_PROVIDER_IDS } from './providerIds';

const checkedAt = '2026-09-09T12:00:00.000Z';
const auth: ProviderAuthenticationEvidence = {
  credentialKind: 'oauth',
  state: 'authenticated',
  checkedAt,
  source: 'local-check',
};
const reconnect =
  'Reconnecting... 2/5 (unexpected status 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection termination)';

describe.each(ACCOUNT_PROVIDER_IDS)('diagnoseProviderFailure: %s', (provider) => {
  const cases: Array<[string, ProviderCredentialKind, unknown, ProviderFailureCode]> = [
    ['missing credentials', 'oauth', { code: 'missing_credentials' }, 'missing_credentials'],
    ['signed out', 'oauth', 'You are not logged in', 'missing_credentials'],
    ['missing API key', 'api-key', 'API key not configured', 'missing_credentials'],
    [
      'OAuth expired',
      'oauth',
      { error: { code: 'refresh_token_expired' } },
      'oauth_reauthentication_required',
    ],
    ['OAuth rejected', 'oauth', { status: 401 }, 'oauth_reauthentication_required'],
    ['API key rejected', 'api-key', { statusCode: 401 }, 'api_credentials_rejected'],
    [
      'API key rejected by message',
      'api-key',
      'Incorrect API key provided',
      'api_credentials_rejected',
    ],
    ['unknown auth method', 'unknown', { response: { status: 401 } }, 'authentication_rejected'],
    [
      'OAuth 403 rejection',
      'oauth',
      { status: 403, error: { type: 'authentication_error' } },
      'oauth_reauthentication_required',
    ],
    [
      'API 403 rejection',
      'api-key',
      { status: 403, error: { code: 'invalid_api_key' } },
      'api_credentials_rejected',
    ],
    ['bare 403', 'oauth', { status: 403, message: 'Forbidden' }, 'unknown'],
    ['invalid thread', 'oauth', { code: 'thread_not_found' }, 'invalid_provider_session'],
    ['expired conversation', 'unknown', 'Conversation has expired', 'invalid_provider_session'],
    [
      'execution policy',
      'oauth',
      { code: 'execution_policy_denied', status: 403 },
      'execution_policy_denied',
    ],
    [
      'sandbox policy',
      'api-key',
      'Sandbox policy denied this operation',
      'execution_policy_denied',
    ],
    ['rate limit', 'oauth', { status: 429 }, 'rate_limited'],
    ['rate limit text', 'unknown', 'Rate limit exceeded', 'rate_limited'],
    ['bad gateway', 'oauth', { httpStatus: 502 }, 'service_unavailable'],
    ['unavailable', 'api-key', { response: { status: '503' } }, 'service_unavailable'],
    ['reconnect', 'oauth', reconnect, 'service_unavailable'],
    ['gateway timeout', 'oauth', { status: 504 }, 'timeout'],
    ['timeout', 'oauth', Object.assign(new Error('slow'), { name: 'TimeoutError' }), 'timeout'],
    ['connection timeout', 'unknown', { code: 'ETIMEDOUT' }, 'timeout'],
    ['deadline', 'unknown', 'Request deadline exceeded', 'timeout'],
    ['overload status', 'oauth', { status: 529 }, 'overloaded'],
    ['overload code', 'api-key', { error: { type: 'overloaded_error' } }, 'overloaded'],
    ['overload message', 'unknown', 'Server is overloaded', 'overloaded'],
    ['DNS', 'oauth', { cause: { code: 'ENOTFOUND' } }, 'connection_failed'],
    ['temporary DNS', 'api-key', { cause: { code: 'EAI_AGAIN' } }, 'connection_failed'],
    ['reset', 'oauth', { code: 'ECONNRESET' }, 'connection_failed'],
    [
      'connection termination',
      'api-key',
      'upstream connect error: connection termination',
      'connection_failed',
    ],
    ['fetch failed', 'unknown', new Error('fetch failed'), 'connection_failed'],
    ['missing CLI', 'unknown', { code: 'ENOENT', syscall: 'spawn codex' }, 'runtime_unavailable'],
    ['missing runtime text', 'oauth', 'Claude CLI not found', 'runtime_unavailable'],
    ['missing ordinary file', 'unknown', { code: 'ENOENT', syscall: 'open' }, 'unknown'],
    [
      'context overflow',
      'api-key',
      { error: { code: 'context_length_exceeded' } },
      'context_overflow',
    ],
    ['prompt overflow', 'oauth', 'Prompt is too long', 'context_overflow'],
    [
      'structured policy beats prose',
      'oauth',
      { code: 'execution_policy_denied', status: 401, message: 'invalid token' },
      'execution_policy_denied',
    ],
    [
      'structured service beats prose',
      'oauth',
      { status: 503, message: 'Try signing in again with your credentials' },
      'service_unavailable',
    ],
    [
      'structured thread beats auth prose',
      'oauth',
      { code: 'invalid_thread_id', message: 'authentication failed' },
      'invalid_provider_session',
    ],
    ['ambiguous expired session', 'oauth', 'Session expired', 'unknown'],
    ['ambiguous permission', 'api-key', 'Permission denied', 'unknown'],
    ['stray status number', 'oauth', 'Failed on line 503', 'unknown'],
    ['unknown object', 'unknown', { unexpected: true }, 'unknown'],
    ['empty error', 'unknown', null, 'unknown'],
  ];
  it.each(cases)('%s', (_name, credentialKind, error, expected) => {
    const result = diagnoseProviderFailure({ provider, credentialKind, error });
    expect(result.diagnosis).toBe(expected);
    expect(result.provider).toBe(provider);
  });

  it.each(['missing', 'signed-out', 'expired', 'rejected'] as const)(
    'uses supplied %s evidence for unexplained failures',
    (state) => {
      const result = diagnoseProviderFailure({
        provider,
        credentialKind: 'oauth',
        error: 'Failed',
        authentication: { ...auth, state },
      });
      expect(result.diagnosis).toBe(
        state === 'missing' || state === 'signed-out'
          ? 'missing_credentials'
          : 'oauth_reauthentication_required',
      );
      expect(result.evidence[0]).toMatchObject({ source: 'authentication-check', checkedAt });
    },
  );

  it.each([auth, undefined])(
    'does not confuse a provider session with authentication (%j)',
    (authentication) => {
      const result = diagnoseProviderFailure({
        provider,
        credentialKind: 'oauth',
        error: 'Thread not found',
        authentication,
      });
      expect(result.diagnosis).toBe('invalid_provider_session');
      expect(result.recovery).toBe('start_new_session');
    },
  );

  it('keeps local authentication separate from an API request rejection', () => {
    const result = diagnoseProviderFailure({
      provider,
      credentialKind: 'api-key',
      error: { status: 401 },
      authentication: auth,
    });
    expect(result.diagnosis).toBe('api_credentials_rejected');
    expect(result.authentication).toEqual(auth);
    expect(result.evidence[0].source).toBe('http-status');
  });

  it('does not use an OAuth observation to classify an unknown API failure', () => {
    expect(
      diagnoseProviderFailure({
        provider,
        credentialKind: 'api-key',
        error: 'Failed',
        authentication: { ...auth, state: 'expired' },
      }).diagnosis,
    ).toBe('unknown');
  });

  it.each([auth, { ...auth, state: 'expired' } as const])(
    'retains request service evidence regardless of local auth (%j)',
    (authentication) => {
      const result = diagnoseProviderFailure({
        provider,
        credentialKind: 'oauth',
        error: reconnect,
        authentication,
      });
      expect(result).toMatchObject({
        diagnosis: 'service_unavailable',
        recovery: 'retry_later',
        httpStatus: 503,
      });
      expect(result.evidence[0].source).toBe('message');
    },
  );

  it('returns only a safe projection, including for cyclic errors', () => {
    const error = {
      status: 429,
      headers: { 'retry-after': '2', Authorization: 'secret-key' },
      message: 'secret-key',
      cause: {},
    };
    error.cause = error;
    const result = diagnoseProviderFailure({
      provider,
      credentialKind: 'api-key',
      error,
      authentication: { ...auth, credentials: 'secret-key' } as ProviderAuthenticationEvidence,
    });
    expect(result.retryAfter).toEqual({ kind: 'delay', delayMs: 2000 });
    expect(JSON.stringify(result)).not.toMatch(/secret-key|Authorization|message|stack/);
  });

  it('preserves absolute retry dates without reading the clock', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock read');
    });
    try {
      const result = diagnoseProviderFailure({
        provider,
        credentialKind: 'unknown',
        error: {
          status: 429,
          headers: new Headers({ 'Retry-After': 'Wed, 09 Sep 2026 13:00:00 GMT' }),
        },
      });
      expect(result.retryAfter).toEqual({ kind: 'date', at: '2026-09-09T13:00:00.000Z' });
    } finally {
      clock.mockRestore();
    }
  });

  it('ignores malformed retry and authentication timestamps', () => {
    const result = diagnoseProviderFailure({
      provider,
      credentialKind: 'oauth',
      error: { status: 503, headers: { 'retry-after': '-1' } },
      authentication: { ...auth, checkedAt: 'secret' },
    });
    expect(result.retryAfter).toBeUndefined();
    expect(result.authentication).toBeUndefined();
  });
});
