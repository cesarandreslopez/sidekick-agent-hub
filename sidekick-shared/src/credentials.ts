/**
 * Read Claude Max OAuth credentials from disk.
 *
 * Shared by sidekick-cli, sidekick-vscode, and any external consumer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ClaudeMaxCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * Reads Claude Max OAuth credentials from `~/.claude/.credentials.json`.
 *
 * Returns `null` if the file does not exist, the token is missing, or the
 * token is expired. Never throws.
 */
export async function readClaudeMaxCredentials(): Promise<ClaudeMaxCredentials | null> {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credPath)) return null;
    const content = await fs.promises.readFile(credPath, 'utf8');
    const parsed = JSON.parse(content);
    const oauth = parsed?.claudeAiOauth;
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
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credPath)) return null;
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(content);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}
