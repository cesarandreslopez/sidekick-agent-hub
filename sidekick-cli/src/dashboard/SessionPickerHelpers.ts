/**
 * Pure helper functions for session picker (shared between blessed and Ink implementations).
 * Extracted from SessionPicker.ts so the logic is testable and reusable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listSessionPreviews } from 'sidekick-shared';
import type { SessionPreview, SessionProviderBase, ProviderId } from 'sidekick-shared';

export interface SessionPickerItem {
  sessionPath: string;
  label: string;
  sessionId: string;
  age: string;
  isActive: boolean;
  providerId?: ProviderId;
}

/** Provider badge colors and short labels for the session picker. */
export const PROVIDER_BADGES: Record<ProviderId, { badge: string; color: string }> = {
  'claude-code': { badge: 'CC', color: 'green' },
  opencode: { badge: 'OC', color: 'cyan' },
  codex: { badge: 'CX', color: 'yellow' },
};

const MAX_ITEMS = 50;
const ACTIVE_THRESHOLD_MS = 60_000;

export function formatRelativeTime(mtime: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - mtime.getTime();
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function collectSessionItems(
  sessionPaths: string[],
  provider: SessionProviderBase,
  now: Date = new Date(),
): SessionPickerItem[] {
  const items: SessionPickerItem[] = [];
  const paths = sessionPaths.slice(0, MAX_ITEMS);

  for (const sp of paths) {
    let mtime: Date;
    try {
      mtime = fs.statSync(sp).mtime;
    } catch {
      continue;
    }

    const rawLabel = provider.extractSessionLabel(sp);
    const label = rawLabel || 'Untitled session';
    const basename = path.basename(sp, path.extname(sp));
    const sessionId = basename.length > 8 ? basename.substring(0, 8) : basename;
    const age = formatRelativeTime(mtime, now);
    const isActive = now.getTime() - mtime.getTime() < ACTIVE_THRESHOLD_MS;

    items.push({ sessionPath: sp, label, sessionId, age, isActive, providerId: provider.id });
  }

  return items;
}

/** Map one shared SessionPreview onto the picker item shape. */
export function previewToPickerItem(
  preview: SessionPreview,
  now: Date = new Date(),
): SessionPickerItem {
  // The preview carries the full provider-canonical id; the picker renders
  // sessionId raw, so keep the historical 8-character display cap.
  const fullId =
    preview.sessionId || path.basename(preview.filePath, path.extname(preview.filePath));
  const sessionId = fullId.length > 8 ? fullId.substring(0, 8) : fullId;
  const modified = new Date(preview.modifiedAt);
  return {
    sessionPath: preview.filePath,
    label: preview.firstUserPrompt || 'Untitled session',
    sessionId,
    age: formatRelativeTime(modified, now),
    isActive: now.getTime() - modified.getTime() < ACTIVE_THRESHOLD_MS,
    providerId: preview.provider,
  };
}

/**
 * Collect session items from multiple providers, sorted by recency.
 * Each item is tagged with its providerId. Labels are read only for the
 * returned slice (via the shared preview index), not every discovered file.
 */
export function collectMultiProviderItems(
  providers: SessionProviderBase[],
  workspacePath: string,
  now: Date = new Date(),
): SessionPickerItem[] {
  return listSessionPreviews(providers, { workspacePath, limit: MAX_ITEMS }).map((preview) =>
    previewToPickerItem(preview, now),
  );
}
