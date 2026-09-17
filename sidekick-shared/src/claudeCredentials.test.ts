import { describe, expect, it } from 'vitest';
import {
  CLAUDE_ACCESS_TOKEN_LIFETIME_MS,
  CLAUDE_REFRESH_TOKEN_LIFETIME_ESTIMATE_MS,
  claudeCredentialFreshness,
  isNewerClaudeCredential,
  parseClaudeCredentialBlob,
  resolveClaudeRefreshExpiry,
} from './claudeCredentials';

describe('claudeCredentials', () => {
  it('parses the stored blob and tolerates the mcpOAuth sibling and unknown keys', () => {
    const parsed = parseClaudeCredentialBlob({
      claudeAiOauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 100,
        refreshTokenExpiresAt: 200,
        scopes: ['user:inference', 42],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        futureField: true,
      },
      mcpOAuth: { server: { token: 'x' } },
    });

    expect(parsed).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 100,
      refreshTokenExpiresAt: 200,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
  });

  it('rejects blobs without an access token', () => {
    expect(parseClaudeCredentialBlob(null)).toBeNull();
    expect(parseClaudeCredentialBlob({})).toBeNull();
    expect(parseClaudeCredentialBlob({ claudeAiOauth: { refreshToken: 'rt' } })).toBeNull();
    expect(parseClaudeCredentialBlob({ mcpOAuth: {} })).toBeNull();
  });

  it('orders credentials by access-token expiry, falling back to the refresh expiry', () => {
    const older = parseClaudeCredentialBlob({ claudeAiOauth: { accessToken: 'a', expiresAt: 10 } });
    const newer = parseClaudeCredentialBlob({ claudeAiOauth: { accessToken: 'b', expiresAt: 20 } });
    const refreshOnly = parseClaudeCredentialBlob({
      claudeAiOauth: { accessToken: 'c', refreshTokenExpiresAt: 15 },
    });
    const bare = parseClaudeCredentialBlob({ claudeAiOauth: { accessToken: 'd' } });

    expect(claudeCredentialFreshness(newer)).toBe(20);
    expect(claudeCredentialFreshness(refreshOnly)).toBe(15);
    expect(claudeCredentialFreshness(bare)).toBe(0);
    expect(claudeCredentialFreshness(null)).toBe(0);
    expect(isNewerClaudeCredential(newer, older)).toBe(true);
    expect(isNewerClaudeCredential(older, newer)).toBe(false);
    expect(isNewerClaudeCredential(newer, newer)).toBe(false);
    expect(isNewerClaudeCredential(bare, null)).toBe(false);
  });

  it('uses the recorded refresh expiry when present and estimates it otherwise', () => {
    const recorded = parseClaudeCredentialBlob({
      claudeAiOauth: { accessToken: 'a', expiresAt: 1_000, refreshTokenExpiresAt: 5_000 },
    });
    expect(resolveClaudeRefreshExpiry(recorded)).toEqual({
      refreshExpiresAt: 5_000,
      estimated: false,
    });

    const expiresAt = 10 * CLAUDE_ACCESS_TOKEN_LIFETIME_MS;
    const legacy = parseClaudeCredentialBlob({ claudeAiOauth: { accessToken: 'a', expiresAt } });
    expect(resolveClaudeRefreshExpiry(legacy)).toEqual({
      refreshExpiresAt:
        expiresAt - CLAUDE_ACCESS_TOKEN_LIFETIME_MS + CLAUDE_REFRESH_TOKEN_LIFETIME_ESTIMATE_MS,
      estimated: true,
    });

    expect(
      resolveClaudeRefreshExpiry(
        parseClaudeCredentialBlob({ claudeAiOauth: { accessToken: 'a' } }),
      ),
    ).toBeNull();
    expect(resolveClaudeRefreshExpiry(null)).toBeNull();
  });
});
