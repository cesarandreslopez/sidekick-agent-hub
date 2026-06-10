import { describe, it, expect } from 'vitest';
import {
  activeProviderAccountStatusSchema,
  activeAccountStatusSchema,
} from './accountStatus';

describe('activeProviderAccountStatusSchema', () => {
  it('accepts a present account with label and email', () => {
    const result = activeProviderAccountStatusSchema.safeParse({
      present: true,
      label: 'Default',
      email: 'user@example.com',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a bare absent account', () => {
    expect(activeProviderAccountStatusSchema.safeParse({ present: false }).success).toBe(true);
  });

  it('rejects a missing present flag', () => {
    expect(activeProviderAccountStatusSchema.safeParse({ label: 'Default' }).success).toBe(false);
  });
});

describe('activeAccountStatusSchema', () => {
  it('round-trips the happy shape getActiveAccountStatus produces', () => {
    const status = {
      ok: true,
      claude: { present: true, label: 'Default', email: 'user@example.com' },
      codex: { present: true, label: 'Work' },
    };
    const result = activeAccountStatusSchema.safeParse(status);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(status);
  });

  it('round-trips the error-branch shape', () => {
    const status = {
      ok: false,
      claude: { present: false },
      codex: { present: false },
      error: 'registry unreadable',
    };
    const result = activeAccountStatusSchema.safeParse(status);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(status);
  });

  it('rejects a status missing a provider entry', () => {
    const result = activeAccountStatusSchema.safeParse({
      ok: true,
      claude: { present: true },
    });
    expect(result.success).toBe(false);
  });
});
