/**
 * Pure helper functions for session picker (shared between blessed and Ink implementations).
 * Extracted from SessionPicker.ts so the logic is testable and reusable.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionProvider, ProviderId } from 'sidekick-shared';

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
  'opencode': { badge: 'OC', color: 'cyan' },
  'codex': { badge: 'CX', color: 'yellow' },
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
  provider: SessionProvider,
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

/**
 * Collect session items from multiple providers, sorted by recency.
 * Each item is tagged with its providerId.
 */
export function collectMultiProviderItems(
  providers: Array<{ provider: SessionProvider; workspacePath: string }>,
  now: Date = new Date(),
): SessionPickerItem[] {
  const allItems: Array<SessionPickerItem & { mtime: number }> = [];

  for (const { provider, workspacePath } of providers) {
    const paths = provider.findAllSessions(workspacePath).slice(0, MAX_ITEMS);
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

      allItems.push({ sessionPath: sp, label, sessionId, age, isActive, providerId: provider.id, mtime: mtime.getTime() });
    }
  }

  // Sort by recency (most recent first)
  allItems.sort((a, b) => b.mtime - a.mtime);
  return allItems.slice(0, MAX_ITEMS);
}
