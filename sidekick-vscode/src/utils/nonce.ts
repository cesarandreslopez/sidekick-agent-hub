import * as crypto from 'crypto';

/**
 * Generates a random nonce string for Content Security Policy.
 *
 * Uses crypto.getRandomValues() for cryptographically secure randomness.
 *
 * @returns A 32-character alphanumeric random string
 */
export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
