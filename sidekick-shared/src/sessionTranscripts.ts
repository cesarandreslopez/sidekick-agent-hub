import type { SessionProviderBase, ProviderId } from './providers/types';
import { statSync } from 'node:fs';
import {
  projectSessionTranscript,
  type CanonicalSessionTranscript,
  type ProjectSessionTranscriptOptions,
} from './transcript';

export interface ProviderSessionIndex {
  provider: ProviderId;
  sessionId: string;
  sessionPath: string;
  label: string | null;
  modifiedAt: string;
}

export interface ListRecentSessionsOptions {
  limit?: number;
}

/** List recent sessions using the provider's existing discovery and metadata APIs. */
export function listRecentSessions(
  provider: SessionProviderBase,
  workspacePath: string,
  options: ListRecentSessionsOptions = {},
): ProviderSessionIndex[] {
  const limit = Math.max(0, options.limit ?? 20);
  return provider
    .findAllSessions(workspacePath)
    .map((sessionPath) => ({
      provider: provider.id,
      sessionId: provider.getSessionId(sessionPath),
      sessionPath,
      label: provider.extractSessionLabel(sessionPath),
      modifiedAt: sessionModifiedAt(provider, sessionPath).toISOString(),
    }))
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, limit);
}

function sessionModifiedAt(provider: SessionProviderBase, sessionPath: string): Date {
  const metadata = provider.getSessionMetadata?.(sessionPath);
  if (metadata) return metadata.mtime;
  try {
    return statSync(sessionPath).mtime;
  } catch {
    return new Date(0);
  }
}

/** Read a canonical transcript through a provider's existing reader. */
export function readSessionTranscript(
  provider: SessionProviderBase,
  sessionPath: string,
  options: Omit<ProjectSessionTranscriptOptions, 'provider' | 'sessionId' | 'sourcePath'> = {},
): CanonicalSessionTranscript {
  const reader = provider.createReader(sessionPath);
  try {
    return projectSessionTranscript(reader.readAll(), {
      ...options,
      provider: provider.id,
      sessionId: provider.getSessionId(sessionPath),
      sourcePath: sessionPath,
    });
  } finally {
    reader.flush();
  }
}
