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
const authenticationMessages = [
  'Conversation session expired because the refresh token is invalid.',
  'Your login has expired, please log in again.',
  'Please re-authenticate to continue.',
];
const policyDenial = 'Permission denied by policy';
const transportMessages = [
  'Reconnecting... 4/5 … Unexpected status 503 Service Unavailable: upstream connect error … connection termination',
  'Falling back from WebSockets to HTTPS transport. unexpected status 503 Service Unavailable …',
];

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

  it.each([
    ...authenticationMessages,
    'Conversation session expired because the OAuth access token has been revoked.',
    'Conversation session expired because the refresh token was rejected.',
  ])('requires OAuth sign-in for %s', (message) => {
    expect(
      diagnoseProviderFailure({ provider, credentialKind: 'oauth', error: new Error(message) }),
    ).toEqual({
      provider,
      credentialKind: 'oauth',
      diagnosis: 'oauth_reauthentication_required',
      recovery: 'sign_in',
      evidence: [{ source: 'message', rule: 'oauth_reauthentication_required' }],
    });
  });

  describe.each([
    ['api-key', 'api_credentials_rejected', 'update_credentials'],
    ['unknown', 'authentication_rejected', 'check_authentication'],
  ] as const)('login messages with %s credentials', (credentialKind, diagnosis, recovery) => {
    it.each(authenticationMessages.slice(1))('respects credential kind for %s', (message) => {
      expect(
        diagnoseProviderFailure({ provider, credentialKind, error: new Error(message) }),
      ).toEqual({
        provider,
        credentialKind,
        diagnosis,
        recovery,
        evidence: [{ source: 'message', rule: diagnosis }],
      });
    });
  });

  describe.each(['oauth', 'api-key'] as const)(
    'policy messages with %s credentials',
    (credentialKind) => {
      it.each([
        ['text', policyDenial, undefined],
        ['Error', new Error(policyDenial), undefined],
        ['403 object', { status: 403, message: policyDenial }, 403],
        [
          'overlapping auth prose',
          new Error(`${policyDenial}. ${authenticationMessages[0]}`),
          undefined,
        ],
      ] as const)('recognizes policy denial from %s', (_name, error, httpStatus) => {
        const result = diagnoseProviderFailure({ provider, credentialKind, error });
        expect(result).toMatchObject({
          diagnosis: 'execution_policy_denied',
          recovery: 'review_execution_policy',
          evidence: [{ source: 'message', rule: 'execution_policy_denied' }],
        });
        expect(result.httpStatus).toBe(httpStatus);
      });
    },
  );

  describe.each([
    [
      { code: 'execution_policy_denied', status: 401 },
      'execution_policy_denied',
      'review_execution_policy',
      'structured-error',
    ],
    [
      { code: 'invalid_thread_id' },
      'invalid_provider_session',
      'start_new_session',
      'structured-error',
    ],
    [{ status: 503 }, 'service_unavailable', 'retry_later', 'http-status'],
  ] as const)('preserves stronger evidence %j', (structured, diagnosis, recovery, source) => {
    it.each(authenticationMessages)('takes precedence over %s', (message) => {
      const result = diagnoseProviderFailure({
        provider,
        credentialKind: 'oauth',
        error: Object.assign(new Error(message), structured),
      });
      expect(result).toMatchObject({
        diagnosis,
        recovery,
        evidence: [{ source, rule: diagnosis }],
      });
      expect(result.httpStatus).toBe('status' in structured ? structured.status : undefined);
    });
  });

  describe.each(['oauth', 'api-key', 'unknown'] as const)(
    'ambiguous messages with %s credentials',
    (credentialKind) => {
      it.each([
        'Session expired',
        'Permission denied',
        'Token budget exhausted',
        'Login page could not be opened',
        'Credentials loaded successfully',
        'Your login has not expired',
        'Re-authentication documentation unavailable',
      ])('does not infer rejection from %s', (message) => {
        expect(
          diagnoseProviderFailure({ provider, credentialKind, error: new Error(message) }),
        ).toEqual({
          provider,
          credentialKind,
          diagnosis: 'unknown',
          recovery: 'inspect_error',
          evidence: [],
        });
      });

      it('leaves a bare 403 ambiguous', () => {
        expect(
          diagnoseProviderFailure({
            provider,
            credentialKind,
            error: { status: 403, message: 'Forbidden' },
          }),
        ).toMatchObject({
          diagnosis: 'unknown',
          recovery: 'inspect_error',
          httpStatus: 403,
          evidence: [],
        });
      });

      it.each([
        ['Login request timed out', 'timeout', 'retry_later'],
        ['Refresh token request timed out', 'timeout', 'retry_later'],
        [
          'Conversation session expired; refresh token is still valid.',
          'invalid_provider_session',
          'start_new_session',
        ],
        ['Conversation token expired', 'invalid_provider_session', 'start_new_session'],
        [
          'Refresh token is valid, but the conversation expired.',
          'invalid_provider_session',
          'start_new_session',
        ],
        ['OAuth conversation expired', 'invalid_provider_session', 'start_new_session'],
        ['OAuth invalid conversation', 'invalid_provider_session', 'start_new_session'],
      ] as const)('preserves non-authentication failure: %s', (message, diagnosis, recovery) => {
        expect(
          diagnoseProviderFailure({ provider, credentialKind, error: new Error(message) }),
        ).toMatchObject({
          diagnosis,
          recovery,
          evidence: [{ source: 'message', rule: diagnosis }],
        });
      });
    },
  );

  describe.each(transportMessages)('terminal transport failure: %s', (message) => {
    it.each([undefined, auth, { ...auth, state: 'expired' } as const])(
      'retains HTTP 503 with authentication observation %j',
      (authentication) => {
        const result = diagnoseProviderFailure({
          provider,
          credentialKind: 'oauth',
          error: new Error(message),
          authentication,
        });
        expect(result).toMatchObject({
          diagnosis: 'service_unavailable',
          recovery: 'retry_later',
          httpStatus: 503,
          evidence: [{ source: 'message', rule: 'service_unavailable' }],
        });
        expect(result.authentication).toEqual(authentication);
      },
    );
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
