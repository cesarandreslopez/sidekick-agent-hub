/**
 * Read Claude Max OAuth credentials from disk.
 *
 * Shared by sidekick-cli, sidekick-vscode, and any external consumer.
 */

import { parseClaudeCredentialBlob } from './claudeCredentials';
import { readActiveCredentials } from './credentialIO';

export interface ClaudeMaxCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

function readParsed(): ClaudeMaxCredentials | null {
  try {
    return parseClaudeCredentialBlob(readActiveCredentials());
  } catch {
    return null;
  }
}

/**
 * Reads Claude Max OAuth credentials.
 *
 * On macOS reads from system Keychain; on Linux/Windows reads from
 * `~/.claude/.credentials.json`. Returns `null` if credentials are
 * absent, the token is missing, or the token is expired. Never throws.
 */
export async function readClaudeMaxCredentials(): Promise<ClaudeMaxCredentials | null> {
  const parsed = readParsed();
  if (!parsed) return null;
  if (parsed.expiresAt && Date.now() > parsed.expiresAt) return null;
  return parsed;
}

/**
 * Like {@link readClaudeMaxCredentials} but returns the stored credential even
 * when the access token has lapsed: the CLI refreshes it on next use, so an
 * expired access token is still a valid login (until the refresh token expires).
 */
export function readClaudeMaxCredentialsRaw(): ClaudeMaxCredentials | null {
  return readParsed();
}

/**
 * Synchronous convenience — returns just the access token or `null`.
 */
export function readClaudeMaxAccessTokenSync(): string | null {
  const parsed = readParsed();
  if (!parsed) return null;
  if (parsed.expiresAt && Date.now() > parsed.expiresAt) return null;
  return parsed.accessToken;
}
