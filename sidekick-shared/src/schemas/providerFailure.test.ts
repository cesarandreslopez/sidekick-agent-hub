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
import { providerFailureDiagnosisSchema } from './providerFailure';

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
