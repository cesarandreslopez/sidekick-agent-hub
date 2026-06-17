import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveAccountInfo } from './accounts';
import type { SavedAccountProfile } from './accountRegistry';

const mocks = vi.hoisted(() => ({
  readActiveClaudeAccount: vi.fn<() => ActiveAccountInfo | null>(),
  getActiveCodexAccount: vi.fn<() => SavedAccountProfile | null>(),
}));

vi.mock('./accounts', () => ({
  readActiveClaudeAccount: mocks.readActiveClaudeAccount,
}));

vi.mock('./codexProfiles', () => ({
  getActiveCodexAccount: mocks.getActiveCodexAccount,
}));

import { getActiveAccountStatus } from './accountStatus';

beforeEach(() => {
  mocks.readActiveClaudeAccount.mockReset();
  mocks.getActiveCodexAccount.mockReset();
});

describe('getActiveAccountStatus', () => {
  it('returns provider status for active Claude and Codex accounts', () => {
    mocks.readActiveClaudeAccount.mockReturnValue({
      email: 'claude@example.com',
      uuid: 'claude-1',
    });
    mocks.getActiveCodexAccount.mockReturnValue({
      id: 'codex-1',
      providerId: 'codex',
      addedAt: '2026-03-23T10:00:00Z',
      label: 'Work',
      email: 'codex@example.com',
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
    mocks.readActiveClaudeAccount.mockReturnValue(null);
    mocks.getActiveCodexAccount.mockReturnValue(null);

    expect(getActiveAccountStatus()).toEqual({
      ok: false,
      claude: { present: false },
      codex: { present: false },
      error: undefined,
    });
  });

  it('can carry a bootstrap error while preserving account details', () => {
    mocks.readActiveClaudeAccount.mockReturnValue({
      email: 'claude@example.com',
      uuid: 'claude-1',
    });
    mocks.getActiveCodexAccount.mockReturnValue(null);

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
    mocks.readActiveClaudeAccount.mockImplementation(() => {
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
