/**
 * Read Claude Max OAuth credentials from disk.
 *
 * Shared by sidekick-cli, sidekick-vscode, and any external consumer.
 */

import { readActiveCredentials } from './credentialIO';

export interface ClaudeMaxCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

interface CredentialsBlob {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

/**
 * Reads Claude Max OAuth credentials.
 *
 * On macOS reads from system Keychain; on Linux/Windows reads from
 * `~/.claude/.credentials.json`. Returns `null` if credentials are
 * absent, the token is missing, or the token is expired. Never throws.
 */
export async function readClaudeMaxCredentials(): Promise<ClaudeMaxCredentials | null> {
  try {
    const raw = readActiveCredentials() as CredentialsBlob | null;
    if (!raw) return null;
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
    };
  } catch {
    return null;
  }
}

/**
 * Synchronous convenience — returns just the access token or `null`.
 */
export function readClaudeMaxAccessTokenSync(): string | null {
  try {
    const raw = readActiveCredentials() as CredentialsBlob | null;
    if (!raw) return null;
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}
