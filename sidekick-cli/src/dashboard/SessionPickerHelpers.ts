/**
 * Pure helper functions for session picker (shared between blessed and Ink implementations).
 * Extracted from SessionPicker.ts so the logic is testable and reusable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listSessionPreviewsAsync } from 'sidekick-shared';
import type { SessionPreview, SessionProviderBase, ProviderId } from 'sidekick-shared';
import { isWithinLiveWindow } from './sessionLiveness';

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

/**
 * The id the picker shows: a prefix of the provider's session id, so it can be
 * pasted into `--session`. Codex ids are UUIDv7, whose first eight characters
 * are the coarse timestamp shared by every session from the same minute, so
 * they keep the next group too.
 */
export function displaySessionId(fullId: string, providerId?: ProviderId): string {
  if (providerId === 'codex' && /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(fullId)) {
    return fullId.slice(0, 13);
  }
  return fullId.length > 8 ? fullId.substring(0, 8) : fullId;
}

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
    // The provider's own id: a Codex rollout's file name is not its session id.
    const sessionId = displaySessionId(provider.getSessionId(sp), provider.id);
    const age = formatRelativeTime(mtime, now);
    const isActive = isWithinLiveWindow(mtime, now);

    items.push({ sessionPath: sp, label, sessionId, age, isActive, providerId: provider.id });
  }

  return items;
}

/** Map one shared SessionPreview onto the picker item shape. */
export function previewToPickerItem(
  preview: SessionPreview,
  now: Date = new Date(),
): SessionPickerItem {
  // The preview carries the full provider-canonical id; the picker shows a
  // pasteable prefix of it.
  const fullId =
    preview.sessionId || path.basename(preview.filePath, path.extname(preview.filePath));
  const sessionId = displaySessionId(fullId, preview.provider);
  const modified = new Date(preview.modifiedAt);
  return {
    sessionPath: preview.filePath,
    label: preview.firstUserPrompt || 'Untitled session',
    sessionId,
    age: formatRelativeTime(modified, now),
    isActive: isWithinLiveWindow(modified, now),
    providerId: preview.provider,
  };
}

/**
 * Collect session items from multiple providers, sorted by recency.
 * Each item is tagged with its providerId. Labels are read only for the
 * returned slice (via the shared preview index), not every discovered file.
 */
export async function collectMultiProviderItems(
  providers: SessionProviderBase[],
  workspacePath: string,
  now: Date = new Date(),
): Promise<SessionPickerItem[]> {
  const { previews } = await listSessionPreviewsAsync(providers, {
    workspacePath,
    limit: MAX_ITEMS,
  });
  return previews.map((preview) => previewToPickerItem(preview, now));
}
