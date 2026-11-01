import { describe, expect, it, vi } from 'vitest';
import {
  decodeCodexErrorInfo,
  diagnoseProviderFailure,
  type ProviderAuthenticationEvidence,
  type ProviderCredentialKind,
  type ProviderFailureCode,
  type ProviderFailureDiagnosis,
  type ProviderFailureInput,
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
      retryable: false,
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
        retryable: false,
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
          retryable: false,
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

describe('diagnoseProviderFailure compatibility', () => {
  const evidenceCheckedAt = '2026-09-09T12:00:00.000Z';
  // Recorded from the classifier before `retryable` and `codexErrorInfo` existed.
  const previous: Array<
    [string, ProviderFailureInput, Omit<ProviderFailureDiagnosis, 'retryable'>]
  > = [
    [
      'OAuth 401',
      { provider: 'claude-code', credentialKind: 'oauth', error: { status: 401 } },
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        diagnosis: 'oauth_reauthentication_required',
        recovery: 'sign_in',
        evidence: [{ source: 'http-status', rule: 'oauth_reauthentication_required' }],
        httpStatus: 401,
      },
    ],
    [
      'API key code with 403',
      {
        provider: 'codex',
        credentialKind: 'api-key',
        error: { status: 403, error: { code: 'invalid_api_key' } },
      },
      {
        provider: 'codex',
        credentialKind: 'api-key',
        diagnosis: 'api_credentials_rejected',
        recovery: 'update_credentials',
        evidence: [{ source: 'structured-error', rule: 'api_credentials_rejected' }],
        httpStatus: 403,
      },
    ],
    [
      '429 with Retry-After',
      {
        provider: 'codex',
        credentialKind: 'unknown',
        error: { status: 429, headers: { 'retry-after': '2' } },
      },
      {
        provider: 'codex',
        credentialKind: 'unknown',
        diagnosis: 'rate_limited',
        recovery: 'retry_later',
        evidence: [{ source: 'http-status', rule: 'rate_limited' }],
        httpStatus: 429,
        retryAfter: { kind: 'delay', delayMs: 2000 },
      },
    ],
    [
      '503 in prose',
      { provider: 'codex', credentialKind: 'oauth', error: new Error(reconnect) },
      {
        provider: 'codex',
        credentialKind: 'oauth',
        diagnosis: 'service_unavailable',
        recovery: 'retry_later',
        evidence: [{ source: 'message', rule: 'service_unavailable' }],
        httpStatus: 503,
      },
    ],
    [
      'overloaded type',
      {
        provider: 'claude-code',
        credentialKind: 'api-key',
        error: { error: { type: 'overloaded_error' } },
      },
      {
        provider: 'claude-code',
        credentialKind: 'api-key',
        diagnosis: 'overloaded',
        recovery: 'retry_later',
        evidence: [{ source: 'structured-error', rule: 'overloaded' }],
      },
    ],
    [
      'nested DNS failure',
      { provider: 'claude-code', credentialKind: 'oauth', error: { cause: { code: 'ENOTFOUND' } } },
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        diagnosis: 'connection_failed',
        recovery: 'check_connection',
        evidence: [{ source: 'structured-error', rule: 'connection_failed' }],
      },
    ],
    [
      'spawn ENOENT',
      {
        provider: 'codex',
        credentialKind: 'unknown',
        error: { code: 'ENOENT', syscall: 'spawn codex' },
      },
      {
        provider: 'codex',
        credentialKind: 'unknown',
        diagnosis: 'runtime_unavailable',
        recovery: 'repair_runtime',
        evidence: [{ source: 'structured-error', rule: 'runtime_unavailable' }],
      },
    ],
    [
      'context length code',
      {
        provider: 'codex',
        credentialKind: 'api-key',
        error: { error: { code: 'context_length_exceeded' } },
      },
      {
        provider: 'codex',
        credentialKind: 'api-key',
        diagnosis: 'context_overflow',
        recovery: 'reduce_context',
        evidence: [{ source: 'structured-error', rule: 'context_overflow' }],
      },
    ],
    [
      'thread prose',
      { provider: 'codex', credentialKind: 'oauth', error: 'Thread not found' },
      {
        provider: 'codex',
        credentialKind: 'oauth',
        diagnosis: 'invalid_provider_session',
        recovery: 'start_new_session',
        evidence: [{ source: 'message', rule: 'invalid_provider_session' }],
      },
    ],
    [
      'policy prose',
      { provider: 'codex', credentialKind: 'oauth', error: policyDenial },
      {
        provider: 'codex',
        credentialKind: 'oauth',
        diagnosis: 'execution_policy_denied',
        recovery: 'review_execution_policy',
        evidence: [{ source: 'message', rule: 'execution_policy_denied' }],
      },
    ],
    [
      'authentication check',
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        error: 'Failed',
        authentication: { ...auth, state: 'expired' },
      },
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        diagnosis: 'oauth_reauthentication_required',
        recovery: 'sign_in',
        evidence: [
          {
            source: 'authentication-check',
            rule: 'oauth_reauthentication_required',
            checkedAt: evidenceCheckedAt,
          },
        ],
        authentication: { ...auth, state: 'expired' },
      },
    ],
    [
      'signed-out prose',
      { provider: 'codex', credentialKind: 'oauth', error: 'You are not logged in' },
      {
        provider: 'codex',
        credentialKind: 'oauth',
        diagnosis: 'missing_credentials',
        recovery: 'sign_in',
        evidence: [{ source: 'message', rule: 'missing_credentials' }],
      },
    ],
    [
      'timeout name',
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        error: Object.assign(new Error('slow'), { name: 'TimeoutError' }),
      },
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        diagnosis: 'timeout',
        recovery: 'retry_later',
        evidence: [{ source: 'structured-error', rule: 'timeout' }],
      },
    ],
    [
      'bare 403',
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        error: { status: 403, message: 'Forbidden' },
      },
      {
        provider: 'claude-code',
        credentialKind: 'oauth',
        diagnosis: 'unknown',
        recovery: 'inspect_error',
        evidence: [],
        httpStatus: 403,
      },
    ],
    [
      'Codex exec turn.failed (message only)',
      {
        provider: 'codex',
        credentialKind: 'unknown',
        error: new Error('Codex error: stream disconnected before completion', {
          cause: { message: 'stream disconnected before completion' },
        }),
      },
      {
        provider: 'codex',
        credentialKind: 'unknown',
        diagnosis: 'unknown',
        recovery: 'inspect_error',
        evidence: [],
      },
    ],
  ];

  it.each(previous)(
    '%s keeps its previous diagnosis and evidence bytes',
    (_name, input, before) => {
      const { retryable, ...rest } = diagnoseProviderFailure(input);
      expect(rest).toEqual(before);
      expect(JSON.stringify(rest.evidence)).toBe(JSON.stringify(before.evidence));
      expect(typeof retryable).toBe('boolean');
    },
  );
});

describe('diagnoseProviderFailure retryable', () => {
  it.each([
    [{ status: 429 }, 'rate_limited', true],
    [{ status: 529 }, 'overloaded', true],
    [{ status: 503 }, 'service_unavailable', true],
    [{ status: 504 }, 'timeout', true],
    [{ code: 'ECONNRESET' }, 'connection_failed', true],
    [{ code: 'missing_credentials' }, 'missing_credentials', false],
    [{ status: 401 }, 'oauth_reauthentication_required', false],
    [{ code: 'thread_not_found' }, 'invalid_provider_session', false],
    [{ code: 'execution_policy_denied' }, 'execution_policy_denied', false],
    [{ code: 'ENOENT', syscall: 'spawn claude' }, 'runtime_unavailable', false],
    [{ code: 'context_length_exceeded' }, 'context_overflow', false],
    [{ status: 403 }, 'unknown', false],
  ] as const)('%j is %s, retryable=%s', (error, diagnosis, retryable) => {
    const result = diagnoseProviderFailure({ provider: 'codex', credentialKind: 'oauth', error });
    expect(result.diagnosis).toBe(diagnosis);
    expect(result.retryable).toBe(retryable);
  });

  it('marks an authentication-check diagnosis as not retryable', () => {
    expect(
      diagnoseProviderFailure({
        provider: 'claude-code',
        credentialKind: 'oauth',
        error: 'Failed',
        authentication: { ...auth, state: 'signed-out' },
      }).retryable,
    ).toBe(false);
  });
});

describe('diagnoseProviderFailure with Codex codexErrorInfo', () => {
  const turnError = (codexErrorInfo: unknown, message = 'turn failed') => ({
    message,
    codexErrorInfo,
    additionalDetails: null,
  });

  it.each([
    ['usageLimitExceeded', 'oauth', 'rate_limited', 'retry_later', false, undefined],
    ['usage_limit_exceeded', 'oauth', 'rate_limited', 'retry_later', false, undefined],
    ['rateLimitExceeded', 'oauth', 'rate_limited', 'retry_later', true, undefined],
    ['serverOverloaded', 'api-key', 'overloaded', 'retry_later', true, undefined],
    ['internalServerError', 'oauth', 'service_unavailable', 'retry_later', true, undefined],
    ['unauthorized', 'oauth', 'oauth_reauthentication_required', 'sign_in', false, undefined],
    ['unauthorized', 'api-key', 'api_credentials_rejected', 'update_credentials', false, undefined],
    [
      'unauthorized',
      'unknown',
      'authentication_rejected',
      'check_authentication',
      false,
      undefined,
    ],
    ['contextWindowExceeded', 'oauth', 'context_overflow', 'reduce_context', false, undefined],
    [
      { httpConnectionFailed: { httpStatusCode: 503 } },
      'oauth',
      'service_unavailable',
      'retry_later',
      true,
      503,
    ],
    [
      { httpConnectionFailed: { httpStatusCode: 429 } },
      'oauth',
      'rate_limited',
      'retry_later',
      true,
      429,
    ],
    [
      { httpConnectionFailed: { httpStatusCode: 401 } },
      'api-key',
      'api_credentials_rejected',
      'update_credentials',
      false,
      401,
    ],
    [
      { httpConnectionFailed: { httpStatusCode: null } },
      'oauth',
      'connection_failed',
      'check_connection',
      true,
      undefined,
    ],
    [
      { responseStreamConnectionFailed: { httpStatusCode: 502 } },
      'oauth',
      'service_unavailable',
      'retry_later',
      true,
      502,
    ],
    [
      { responseStreamDisconnected: { httpStatusCode: null } },
      'oauth',
      'connection_failed',
      'check_connection',
      true,
      undefined,
    ],
    [
      { responseTooManyFailedAttempts: { httpStatusCode: 504 } },
      'oauth',
      'timeout',
      'retry_later',
      true,
      504,
    ],
    [
      { http_connection_failed: { http_status_code: 529 } },
      'oauth',
      'overloaded',
      'retry_later',
      true,
      529,
    ],
  ] as const)(
    'decodes %j (%s credentials)',
    (info, credentialKind, diagnosis, recovery, retryable, httpStatus) => {
      const kind = decodeCodexErrorInfo(info)!.kind;
      for (const error of [
        turnError(info),
        new Error('Codex error: turn failed', { cause: turnError(info) }),
        { error: turnError(info), willRetry: false },
        { data: { codex_error_info: info, message: 'turn failed' } },
      ]) {
        const result = diagnoseProviderFailure({ provider: 'codex', credentialKind, error });
        expect(result).toMatchObject({ diagnosis, recovery, retryable });
        expect(result.httpStatus).toBe(httpStatus);
        expect(result.evidence).toEqual([
          { source: 'structured-error', rule: diagnosis, codexErrorInfo: kind },
        ]);
      }
    },
  );

  it('keeps a usage limit retryable when the provider says when to retry', () => {
    const result = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: { ...turnError('usageLimitExceeded'), headers: { 'retry-after': '60' } },
    });
    expect(result).toMatchObject({
      diagnosis: 'rate_limited',
      retryable: true,
      retryAfter: { kind: 'delay', delayMs: 60_000 },
    });
  });

  it('outranks prose and HTTP status on the same error', () => {
    const result = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: {
        status: 401,
        ...turnError('serverOverloaded', 'Your login has expired, please log in again.'),
      },
    });
    expect(result).toMatchObject({ diagnosis: 'overloaded', retryable: true, httpStatus: 401 });
  });

  it('lets an outer structured code outrank a nested codexErrorInfo', () => {
    const result = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: { code: 'thread_not_found', cause: turnError('internalServerError') },
    });
    expect(result.diagnosis).toBe('invalid_provider_session');
    expect(result.evidence).toEqual([
      { source: 'structured-error', rule: 'invalid_provider_session' },
    ]);
  });

  it('treats an unclassified codex HTTP status like a structured status', () => {
    for (const message of ['unexpected status 503 Service Unavailable', 'Forbidden']) {
      const result = diagnoseProviderFailure({
        provider: 'codex',
        credentialKind: 'oauth',
        error: turnError({ httpConnectionFailed: { httpStatusCode: 403 } }, message),
      });
      expect(result.httpStatus).toBe(403);
      expect(result).toEqual(
        diagnoseProviderFailure({
          provider: 'codex',
          credentialKind: 'oauth',
          error: { status: 403, message },
        }),
      );
    }
  });

  it.each([
    'badRequest',
    'cyberPolicy',
    'sandboxError',
    'sessionBudgetExceeded',
    'threadRollbackFailed',
    'other',
    { activeTurnNotSteerable: { turnKind: 'review' } },
    'notAVariant',
    { somethingElse: { httpStatusCode: 503 } },
    null,
    42,
  ])('leaves %j to the existing rules', (info) => {
    for (const message of ['Rate limit exceeded', 'Prompt is too long', 'something odd']) {
      const withInfo = diagnoseProviderFailure({
        provider: 'codex',
        credentialKind: 'oauth',
        error: turnError(info, message),
      });
      const without = diagnoseProviderFailure({
        provider: 'codex',
        credentialKind: 'oauth',
        error: { message, additionalDetails: null },
      });
      expect(withInfo).toEqual(without);
    }
  });

  it('projects no provider text from a codexErrorInfo error', () => {
    const result = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: {
        message: 'secret-detail',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503, body: 'secret-detail' } },
        additionalDetails: 'secret-detail',
      },
    });
    expect(result.diagnosis).toBe('service_unavailable');
    expect(JSON.stringify(result)).not.toMatch(/secret-detail|message|additionalDetails/);
  });
});

describe('decodeCodexErrorInfo', () => {
  it.each([
    ['serverOverloaded', { kind: 'serverOverloaded' }],
    ['server_overloaded', { kind: 'serverOverloaded' }],
    ['usage_limit_exceeded', { kind: 'usageLimitExceeded' }],
    ['other', { kind: 'other' }],
    [
      { httpConnectionFailed: { httpStatusCode: 503 } },
      { kind: 'httpConnectionFailed', httpStatusCode: 503 },
    ],
    [{ httpConnectionFailed: { httpStatusCode: null } }, { kind: 'httpConnectionFailed' }],
    [{ httpConnectionFailed: { httpStatusCode: 99 } }, { kind: 'httpConnectionFailed' }],
    [
      { response_too_many_failed_attempts: { http_status_code: 429 } },
      { kind: 'responseTooManyFailedAttempts', httpStatusCode: 429 },
    ],
    [{ activeTurnNotSteerable: { turnKind: 'compact' } }, { kind: 'activeTurnNotSteerable' }],
  ] as const)('decodes %j', (value, expected) => {
    expect(decodeCodexErrorInfo(value)).toEqual(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'nope',
    42,
    [],
    ['serverOverloaded'],
    { nope: {} },
    'x'.repeat(65),
  ])('ignores %j', (value) => {
    expect(decodeCodexErrorInfo(value)).toBeUndefined();
  });

  it('survives hostile objects', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(decodeCodexErrorInfo(hostile)).toBeUndefined();
    expect(
      diagnoseProviderFailure({
        provider: 'codex',
        credentialKind: 'oauth',
        error: { codexErrorInfo: hostile, status: 503 },
      }).diagnosis,
    ).toBe('service_unavailable');
  });
});
