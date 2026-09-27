import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decideLiveClaudeWrite, type LiveClaudeWriteRequest } from './claudeLiveGuard';
import {
  claudeLoginOnly,
  claudeRefreshFingerprint,
  mergeClaudeLoginIntoLive,
} from './claudeCredentials';

const blob = (token: string, expiresAt: number, extra: Record<string, unknown> = {}) => ({
  claudeAiOauth: { accessToken: `a-${token}`, refreshToken: `r-${token}`, expiresAt },
  ...extra,
});

function decide(overrides: Partial<LiveClaudeWriteRequest>) {
  return decideLiveClaudeWrite({
    intent: 'relogin',
    live: { status: 'ok', blob: blob('live', 100) },
    liveAccountUuid: 'acct-a',
    candidate: blob('cand', 200),
    candidateAccountUuid: 'acct-a',
    ...overrides,
  });
}

describe('decideLiveClaudeWrite', () => {
  it('refuses everything while the live store cannot be read', () => {
    for (const intent of ['switch', 'relogin', 'repair', 'rollback'] as const) {
      expect(decide({ intent, live: { status: 'error' } })).toMatchObject({
        allow: false,
        code: 'live-unreadable',
      });
    }
  });

  describe('relogin / repair (same account)', () => {
    it('allows only a strictly fresher, different refresh token', () => {
      expect(decide({})).toEqual({ allow: true });
      expect(decide({ intent: 'repair' })).toEqual({ allow: true });
      expect(decide({ candidate: blob('cand', 100) })).toMatchObject({ code: 'not-newer' });
      expect(decide({ candidate: blob('cand', 50) })).toMatchObject({ code: 'not-newer' });
      // Same link of the chain, even if its recorded expiry claims to be later.
      expect(decide({ candidate: blob('live', 300) })).toMatchObject({ code: 'not-newer' });
    });

    it('never crosses accounts', () => {
      expect(decide({ candidateAccountUuid: 'acct-b' })).toMatchObject({
        code: 'different-account',
      });
    });

    it('allows when live holds nothing to protect', () => {
      expect(decide({ live: { status: 'absent' } })).toEqual({ allow: true });
      expect(decide({ live: { status: 'corrupt' } })).toEqual({ allow: true });
      expect(decide({ liveAccountUuid: null, live: { status: 'absent' } })).toEqual({
        allow: true,
      });
    });

    it('refuses something that is not a Claude login', () => {
      expect(decide({ candidate: { mcpOAuth: {} } })).toMatchObject({ code: 'invalid-candidate' });
    });
  });

  describe('switch (another account)', () => {
    const switchTo = (overrides: Partial<LiveClaudeWriteRequest>) =>
      decide({ intent: 'switch', candidateAccountUuid: 'acct-b', ...overrides });

    it('requires the outgoing login to have been captured', () => {
      expect(switchTo({})).toMatchObject({ code: 'not-captured' });
      expect(switchTo({ capturedOutgoing: true })).toEqual({ allow: true });
      // Nothing live to capture.
      expect(switchTo({ live: { status: 'absent' } })).toEqual({ allow: true });
    });

    it('refuses a candidate that is the same refresh-token link as live', () => {
      expect(switchTo({ capturedOutgoing: true, candidate: blob('live', 500) })).toMatchObject({
        code: 'same-link',
      });
    });

    it('refuses to "switch" to the account that is already live', () => {
      expect(switchTo({ capturedOutgoing: true, candidateAccountUuid: 'acct-a' })).toMatchObject({
        code: 'same-account',
      });
    });
  });

  describe('rollback', () => {
    const written = blob('cand', 200);
    it('restores only while live still holds exactly what the switch wrote', () => {
      expect(
        decide({ intent: 'rollback', live: { status: 'ok', blob: written }, written }),
      ).toEqual({ allow: true });
      expect(decide({ intent: 'rollback', live: { status: 'absent' }, written })).toEqual({
        allow: true,
      });
      expect(
        decide({ intent: 'rollback', live: { status: 'ok', blob: blob('other', 900) }, written }),
      ).toMatchObject({ code: 'live-changed' });
    });
  });
});

describe('credential blob helpers', () => {
  it('fingerprints the refresh token without exposing it', () => {
    const fp = claudeRefreshFingerprint({ accessToken: 'a', refreshToken: 'secret-refresh' });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('secret');
    expect(claudeRefreshFingerprint({ accessToken: 'a' })).toBeNull();
  });

  it('keeps only the Claude login for profile copies', () => {
    expect(claudeLoginOnly(blob('x', 1, { mcpOAuth: { s: 1 } }))).toEqual({
      claudeAiOauth: blob('x', 1).claudeAiOauth,
    });
    expect(claudeLoginOnly({ mcpOAuth: {} })).toBeNull();
  });

  it('installs the candidate login but keeps live MCP tokens (plus candidate-only servers)', () => {
    const live = blob('live', 1, { mcpOAuth: { shared: 'live', liveOnly: 'l' }, other: 1 });
    const candidate = blob('cand', 2, { mcpOAuth: { shared: 'stale', candOnly: 'c' } });
    expect(mergeClaudeLoginIntoLive(live, candidate)).toEqual({
      claudeAiOauth: candidate.claudeAiOauth,
      mcpOAuth: { shared: 'live', liveOnly: 'l', candOnly: 'c' },
      other: 1,
    });
    expect(mergeClaudeLoginIntoLive(null, blob('cand', 2))).toEqual(blob('cand', 2));
  });
});

describe('only the guarded installer writes the live store (I2, static)', () => {
  const srcDir = __dirname;
  const productionFiles = fs
    .readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.startsWith('testing'),
    );

  it('imports the unguarded live writer in accounts.ts only', () => {
    const importers = productionFiles.filter((file) =>
      fs
        .readFileSync(path.join(srcDir, file), 'utf8')
        .includes('writeLiveClaudeCredentialStoreUnguarded'),
    );
    expect(importers.sort()).toEqual(['accounts.ts', 'credentialIO.ts']);
    const accounts = fs.readFileSync(path.join(srcDir, 'accounts.ts'), 'utf8');
    // One call site, inside installIntoLiveClaudeStore.
    expect(accounts.match(/writeLiveClaudeCredentialStoreUnguarded\(/g)).toHaveLength(1);
  });

  it('never calls writeActiveCredentials without a config directory', () => {
    // credentialIO.ts defines the function (and names it in its refusal).
    for (const file of productionFiles.filter((f) => f !== 'credentialIO.ts')) {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      for (const call of source.matchAll(/writeActiveCredentials\(([^)]*)\)/g)) {
        expect(call[1], `${file}: ${call[0]}`).toMatch(/,/);
      }
    }
  });
});
