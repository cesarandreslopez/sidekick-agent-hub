import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  diagnoseProviderFailure,
  PROVIDER_FAILURE_CODES,
  PROVIDER_RECOVERY_ACTIONS,
  type ProviderFailureDiagnosis,
  type ProviderFailureInput,
} from '../providerFailure';
import { ACCOUNT_PROVIDER_IDS } from '../providerIds';
import {
  PROVIDER_FAILURE_DIAGNOSIS_BOUNDS,
  boundedProviderFailureDiagnosisSchema,
  providerFailureDiagnosisSchema,
} from './providerFailure';

const checkedAt = '2026-09-09T12:00:00.000Z';
const errors: Array<Pick<ProviderFailureInput, 'credentialKind' | 'error' | 'authentication'>> = [
  { credentialKind: 'oauth', error: { code: 'missing_credentials' } },
  { credentialKind: 'oauth', error: { status: 401 } },
  { credentialKind: 'api-key', error: 'Incorrect API key provided' },
  { credentialKind: 'unknown', error: { status: 429, headers: { 'retry-after': '2' } } },
  {
    credentialKind: 'unknown',
    error: {
      status: 429,
      headers: new Headers({ 'Retry-After': 'Wed, 09 Sep 2026 13:00:00 GMT' }),
    },
  },
  { credentialKind: 'oauth', error: { status: 503 } },
  { credentialKind: 'oauth', error: 'Permission denied by policy' },
  { credentialKind: 'unknown', error: new Error('something odd') },
  {
    credentialKind: 'oauth',
    error: { status: 401 },
    authentication: { credentialKind: 'oauth', state: 'expired', checkedAt, source: 'local-check' },
  },
  { credentialKind: 'oauth', error: { codexErrorInfo: 'flexUnavailable' } },
  { credentialKind: 'oauth', error: { codexErrorInfo: 'too_many_denials' } },
  { credentialKind: 'oauth', error: { codexErrorInfo: 'someFutureVariant' } },
  {
    credentialKind: 'oauth',
    error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
  },
];

describe('providerFailureDiagnosisSchema', () => {
  it.each(ACCOUNT_PROVIDER_IDS)(
    'accepts every diagnosis the classifier returns for %s',
    (provider) => {
      for (const input of errors) {
        const diagnosis = diagnoseProviderFailure({ provider, ...input });
        expect(providerFailureDiagnosisSchema.parse(diagnosis)).toEqual(diagnosis);
      }
    },
  );

  it('rejects codes and recovery actions outside the published lists', () => {
    const valid = diagnoseProviderFailure({
      provider: 'codex',
      credentialKind: 'oauth',
      error: { status: 401 },
    });
    expect(providerFailureDiagnosisSchema.safeParse({ ...valid, diagnosis: 'nope' }).success).toBe(
      false,
    );
    expect(providerFailureDiagnosisSchema.safeParse({ ...valid, recovery: 'nope' }).success).toBe(
      false,
    );
    expect(new Set(PROVIDER_FAILURE_CODES).size).toBe(PROVIDER_FAILURE_CODES.length);
    expect(new Set(PROVIDER_RECOVERY_ACTIONS).size).toBe(PROVIDER_RECOVERY_ACTIONS.length);
  });

  it('infers exactly the ProviderFailureDiagnosis type', () => {
    expectTypeOf<
      z.infer<typeof providerFailureDiagnosisSchema>
    >().toEqualTypeOf<ProviderFailureDiagnosis>();
  });
});

describe('boundedProviderFailureDiagnosisSchema', () => {
  const full: ProviderFailureDiagnosis = {
    provider: 'codex',
    credentialKind: 'oauth',
    diagnosis: 'rate_limited',
    recovery: 'retry_later',
    retryable: true,
    evidence: [{ source: 'structured-error', rule: 'rate_limited', checkedAt }],
    authentication: {
      credentialKind: 'oauth',
      state: 'authenticated',
      checkedAt,
      source: 'local-check',
    },
    httpStatus: 429,
    retryAfter: { kind: 'date', at: checkedAt },
  };
  const evidence = full.evidence[0];

  it.each(ACCOUNT_PROVIDER_IDS)(
    'accepts every diagnosis the classifier returns for %s',
    (provider) => {
      for (const input of errors) {
        const diagnosis = diagnoseProviderFailure({ provider, ...input });
        expect(boundedProviderFailureDiagnosisSchema.parse(diagnosis)).toEqual(diagnosis);
      }
    },
  );

  it('accepts values at every bound', () => {
    const bounds = PROVIDER_FAILURE_DIAGNOSIS_BOUNDS;
    const longest = '2026-09-09T12:00:00.000000000Z';
    expect(longest.length).toBeLessThanOrEqual(bounds.timestampMaxChars);
    for (const value of [
      full,
      { ...full, httpStatus: bounds.httpStatusMin },
      { ...full, httpStatus: bounds.httpStatusMax },
      { ...full, retryAfter: { kind: 'delay', delayMs: 0 } },
      { ...full, retryAfter: { kind: 'delay', delayMs: Number.MAX_SAFE_INTEGER } },
      { ...full, retryAfter: { kind: 'date', at: longest } },
      { ...full, evidence: Array.from({ length: bounds.maxEvidence }, () => evidence) },
      { ...full, evidence: [] },
    ]) {
      expect(
        boundedProviderFailureDiagnosisSchema.safeParse(value).success,
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it.each([
    ['an empty checkedAt', { ...full, authentication: { ...full.authentication!, checkedAt: '' } }],
    [
      'a 33-character checkedAt',
      { ...full, authentication: { ...full.authentication!, checkedAt: `${checkedAt}123456789` } },
    ],
    [
      'an unparseable checkedAt',
      { ...full, authentication: { ...full.authentication!, checkedAt: 'yesterday' } },
    ],
    [
      'an unparseable evidence checkedAt',
      { ...full, evidence: [{ ...evidence, checkedAt: 'soon' }] },
    ],
    ['an unparseable retry date', { ...full, retryAfter: { kind: 'date', at: 'later' } }],
    ['an oversized retry date', { ...full, retryAfter: { kind: 'date', at: 'x'.repeat(10_000) } }],
    ['httpStatus 99', { ...full, httpStatus: 99 }],
    ['httpStatus 600', { ...full, httpStatus: 600 }],
    ['a fractional httpStatus', { ...full, httpStatus: 429.5 }],
    ['a negative delay', { ...full, retryAfter: { kind: 'delay', delayMs: -1 } }],
    ['an infinite delay', { ...full, retryAfter: { kind: 'delay', delayMs: Infinity } }],
    ['a NaN delay', { ...full, retryAfter: { kind: 'delay', delayMs: Number.NaN } }],
    ['a delay past MAX_SAFE_INTEGER', { ...full, retryAfter: { kind: 'delay', delayMs: 2 ** 60 } }],
    ['nine evidence entries', { ...full, evidence: Array.from({ length: 9 }, () => evidence) }],
  ])('rejects %s', (_label, value) => {
    expect(boundedProviderFailureDiagnosisSchema.safeParse(value).success).toBe(false);
    // The unbounded schema stays as permissive as before for stored data.
    if (!/delay|NaN/.test(_label)) {
      expect(providerFailureDiagnosisSchema.safeParse(value).success).toBe(true);
    }
  });

  it('drops a Codex variant it does not know instead of failing', () => {
    const newer = {
      ...full,
      evidence: [{ ...evidence, codexErrorInfo: 'someFutureVariant' }],
      extra: 'stripped',
    };
    const parsed = boundedProviderFailureDiagnosisSchema.parse(newer);
    expect(parsed.evidence[0].codexErrorInfo).toBeUndefined();
    expect(parsed.evidence[0].rule).toBe('rate_limited');
    expect(parsed).not.toHaveProperty('extra');
    expect(providerFailureDiagnosisSchema.safeParse(newer).success).toBe(false);
    expect(
      boundedProviderFailureDiagnosisSchema.parse({
        ...full,
        evidence: [{ ...evidence, codexErrorInfo: 'tooManyDenials' }],
      }).evidence[0].codexErrorInfo,
    ).toBe('tooManyDenials');
  });

  it('infers exactly the ProviderFailureDiagnosis type', () => {
    expectTypeOf<
      z.infer<typeof boundedProviderFailureDiagnosisSchema>
    >().toEqualTypeOf<ProviderFailureDiagnosis>();
  });
});
