import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  accountProviderIdSchema,
  accountManagerResultSchema,
  beginAccountLoginResultSchema,
  accountLoginStatusSchema,
  accountEntrySchema,
  savedAccountProfileSchema,
  listAllAccountsResultSchema,
} from './accountManager';
import type { AccountEntry, AccountManagerResult } from '../accounts';
import type {
  AccountProviderId,
  SavedAccountProfile,
} from '../accountRegistry';
import type {
  AccountLoginStatus,
  BeginAccountLoginResult,
  ListAllAccountsResult,
} from '../accountManager';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _ProviderParity = Assert<Equal<z.infer<typeof accountProviderIdSchema>, AccountProviderId>>;
type _ResultParity = Assert<Equal<z.infer<typeof accountManagerResultSchema>, AccountManagerResult>>;
type _BeginParity = Assert<Equal<z.infer<typeof beginAccountLoginResultSchema>, BeginAccountLoginResult>>;
type _StatusParity = Assert<Equal<z.infer<typeof accountLoginStatusSchema>, AccountLoginStatus>>;
type _EntryParity = Assert<Equal<z.infer<typeof accountEntrySchema>, AccountEntry>>;
type _ProfileParity = Assert<Equal<z.infer<typeof savedAccountProfileSchema>, SavedAccountProfile>>;
type _ListParity = Assert<Equal<z.infer<typeof listAllAccountsResultSchema>, ListAllAccountsResult>>;

const claudeAccount = {
  uuid: 'claude-uuid',
  email: 'user@example.com',
  label: 'Work',
  addedAt: '2026-06-21T00:00:00.000Z',
};

const codexProfile = {
  id: 'codex-id',
  providerId: 'codex',
  addedAt: '2026-06-21T00:00:00.000Z',
  label: 'Work',
  email: 'user@example.com',
  providerAccountId: 'provider-account-id',
  metadata: {
    email: 'user@example.com',
    workspaceId: 'workspace-id',
    planType: 'pro',
    authMode: 'chatgpt',
  },
};

describe('accountManager schemas', () => {
  it('parses provider ids', () => {
    expect(accountProviderIdSchema.parse('claude-code')).toBe('claude-code');
    expect(() => accountProviderIdSchema.parse('opencode')).toThrow();
  });

  it('round-trips account manager results', () => {
    const result = {
      success: true,
      warning: 'Restart running sessions.',
      needsLogin: true,
      profileId: 'profile-id',
      codexHome: '/tmp/codex-home',
    };
    expect(accountManagerResultSchema.parse(result)).toEqual(result);
    expect(() => accountManagerResultSchema.parse({ error: 'missing success' })).toThrow();
  });

  it('round-trips begin login success and failure shapes', () => {
    const success = {
      success: true,
      loginId: 'login-id',
      command: 'claude',
      args: ['/login'],
      env: { CLAUDE_CONFIG_DIR: '/tmp/claude-profile' },
      configDir: '/tmp/claude-profile',
    };
    const failure = {
      success: false,
      error: 'Claude accounts require a non-empty label.',
    };
    expect(beginAccountLoginResultSchema.parse(success)).toEqual(success);
    expect(beginAccountLoginResultSchema.parse(failure)).toEqual(failure);
    expect(() => beginAccountLoginResultSchema.parse({ success: true })).toThrow();
  });

  it('round-trips login status shapes', () => {
    expect(accountLoginStatusSchema.parse({
      state: 'authenticated',
      email: 'user@example.com',
    })).toEqual({
      state: 'authenticated',
      email: 'user@example.com',
    });
    expect(accountLoginStatusSchema.parse({
      state: 'failed',
      error: 'Login timed out.',
    })).toEqual({
      state: 'failed',
      error: 'Login timed out.',
    });
    expect(() => accountLoginStatusSchema.parse({ state: 'complete' })).toThrow();
  });

  it('round-trips saved account entries and provider-neutral lists', () => {
    expect(accountEntrySchema.parse(claudeAccount)).toEqual(claudeAccount);
    expect(savedAccountProfileSchema.parse(codexProfile)).toEqual(codexProfile);

    const list = {
      claude: [claudeAccount],
      codex: [codexProfile],
      activeByProvider: {
        'claude-code': 'claude-uuid',
        codex: 'codex-id',
      },
    };
    expect(listAllAccountsResultSchema.parse(list)).toEqual(list);
    expect(() => listAllAccountsResultSchema.parse({
      claude: [],
      codex: [],
      activeByProvider: { codex: null },
    })).toThrow();
  });
});
