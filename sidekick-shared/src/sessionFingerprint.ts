/**
 * Size/mtime fingerprints for session sources.
 *
 * Shared by the observed-session collector, the V1 adapter's watch loop, and
 * the usage cache, so "has this session changed?" is answered the same way
 * everywhere without re-reading content.
 *
 * @module sessionFingerprint
 */

import { statSync } from 'node:fs';
import type { SessionProviderBase } from './providers/types';

export interface ObservedSessionFingerprintParts {
  sizeBytes: number;
  mtimeMs: number;
}

/** Structured size/mtime fingerprint; returns null for inaccessible or synthetic paths. */
export function fileFingerprintParts(sourcePath: string): ObservedSessionFingerprintParts | null {
  try {
    const stat = statSync(sourcePath);
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Size/mtime fingerprint suitable for retry bypass; returns null for synthetic DB locators. */
export function fileFingerprint(sourcePath: string): string | null {
  const parts = fileFingerprintParts(sourcePath);
  return parts ? fingerprintString(parts) : null;
}

/** Canonical `${sizeBytes}:${mtimeMs}` form of a fingerprint. */
export function fingerprintString(parts: ObservedSessionFingerprintParts): string {
  return `${parts.sizeBytes}:${parts.mtimeMs}`;
}

/**
 * Fingerprint for a session path, falling back to provider metadata (mtime
 * only) for database-backed sessions whose path is synthetic.
 */
export function sessionFingerprintParts(
  provider: SessionProviderBase,
  sessionPath: string,
): ObservedSessionFingerprintParts | null {
  const parts = fileFingerprintParts(sessionPath);
  if (parts) return parts;
  const metadata = provider.getSessionMetadata?.(sessionPath);
  return metadata ? { sizeBytes: 0, mtimeMs: metadata.mtime.getTime() } : null;
}
