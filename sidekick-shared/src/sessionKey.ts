/**
 * The key that names one session file across prompt history, usage events,
 * tool-call origins and session listings: `<provider>:<session id>:<hash>`,
 * where the hash (12 hex characters of the path's SHA-256) tells apart two
 * files that carry the same session id.
 *
 * @module sessionKey
 */

import { createHash } from 'crypto';

/** `<provider>:<sessionId>:<12 hex of sha256(filePath)>`. */
export function computeSessionKey(provider: string, sessionId: string, filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 12);
  return `${provider}:${sessionId}:${hash}`;
}
