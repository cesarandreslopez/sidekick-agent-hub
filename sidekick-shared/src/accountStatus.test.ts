import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedActiveAccount } from './accountRegistry';

const mocks = vi.hoisted(() => ({
  resolveActiveClaudeAccount: vi.fn<() => ResolvedActiveAccount>(),
  resolveActiveCodexAccount: vi.fn<() => ResolvedActiveAccount>(),
}));

vi.mock('./accounts', () => ({
  resolveActiveClaudeAccount: mocks.resolveActiveClaudeAccount,
}));

vi.mock('./codexProfiles', () => ({
  resolveActiveCodexAccount: mocks.resolveActiveCodexAccount,
}));

import { getActiveAccountStatus } from './accountStatus';

beforeEach(() => {
  mocks.resolveActiveClaudeAccount.mockReset();
  mocks.resolveActiveCodexAccount.mockReset();
});

describe('getActiveAccountStatus', () => {
  it('returns provider status for active Claude and Codex accounts', () => {
    mocks.resolveActiveClaudeAccount.mockReturnValue({
      email: 'claude@example.com',
      source: 'live',
    });
    mocks.resolveActiveCodexAccount.mockReturnValue({
      email: 'codex@example.com',
      label: 'Work',
      source: 'live',
    });

    expect(getActiveAccountStatus()).toEqual({
      ok: true,
      claude: {
        present: true,
        email: 'claude@example.com',
        label: 'claude@example.com',
      },
      codex: {
        present: true,
        email: 'codex@example.com',
        label: 'Work',
      },
      error: undefined,
    });
  });

  it('keeps the shape stable when accounts are missing', () => {
    mocks.resolveActiveClaudeAccount.mockReturnValue({ source: 'none' });
    mocks.resolveActiveCodexAccount.mockReturnValue({ source: 'none' });

    expect(getActiveAccountStatus()).toEqual({
      ok: false,
      claude: { present: false },
      codex: { present: false },
      error: undefined,
    });
  });

  it('can carry a bootstrap error while preserving account details', () => {
    mocks.resolveActiveClaudeAccount.mockReturnValue({
      email: 'claude@example.com',
      source: 'live',
    });
    mocks.resolveActiveCodexAccount.mockReturnValue({ source: 'none' });

    expect(getActiveAccountStatus('bootstrap failed')).toEqual({
      ok: true,
      claude: {
        present: true,
        email: 'claude@example.com',
        label: 'claude@example.com',
      },
      codex: { present: false },
      error: 'bootstrap failed',
    });
  });

  it('returns empty provider status if a read throws', () => {
    mocks.resolveActiveClaudeAccount.mockImplementation(() => {
      throw new Error('read failed');
    });

    expect(getActiveAccountStatus()).toEqual({
      ok: false,
      claude: { present: false },
      codex: { present: false },
      error: 'read failed',
    });
  });
});
