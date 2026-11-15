/**
 * Session scoping for the persisted-data panels (Tasks, Kanban, Notes,
 * Decisions, Plans).
 *
 * The "active session" filter is a mode, resolved against the live session
 * id every time it is applied, so it follows an auto-switch to a newer
 * session. Ids are compared in a normalised form: hosts record the same
 * session differently (the CLI follows a Codex rollout by its file name,
 * `rollout-<time>-<uuid>`, the VS Code extension stores the bare `<uuid>`),
 * so a UUID inside an id is the identity. Records with no session id, or
 * written by the CLI itself (`sessionId: 'cli'`), are not tied to a session
 * and always show.
 */

import type { PanelItem } from './panels/types';

export interface SessionFilter {
  /** Show only records of the live session (resolved at filter time). */
  active?: boolean;
  /** Show only records from this local date (YYYY-MM-DD). */
  date?: string;
  label: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The identity part of a session id: its UUID when it has one. */
export function normalizeSessionId(id: string): string {
  const uuid = id.match(UUID_RE);
  return (uuid ? uuid[0] : id).toLowerCase();
}

/**
 * Whether a recorded session id names the live session. Exact identity, plus
 * the legacy stores that kept only the first 8 characters of a UUID — never a
 * bare 8-character prefix of a non-UUID id (every Codex file name starts with
 * `rollout-`).
 */
export function sameSession(recorded: string, live: string): boolean {
  const a = normalizeSessionId(recorded);
  const b = normalizeSessionId(live);
  if (!a || !b) return false;
  if (a === b) return true;
  return /^[0-9a-f]{8}$/.test(a) && UUID_RE.test(b) && b.startsWith(a);
}

/** Record ids that do not tie a record to a session. */
function isUnscoped(id: string | undefined): boolean {
  return !id || id === 'cli';
}

/** The domain record behind a panel item (Plans wrap theirs in an envelope). */
function recordOf(item: PanelItem): Record<string, unknown> | undefined {
  const data = item.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (data.plan && typeof data.plan === 'object') return data.plan as Record<string, unknown>;
  return data;
}

export function matchesSessionFilter(
  item: PanelItem,
  filter: SessionFilter,
  liveSessionId: string | undefined,
): boolean {
  const data = item.data as Record<string, unknown> | undefined;
  const record = recordOf(item);
  if (!record) return false;

  if (filter.active) {
    // The live plan comes from the live session by definition.
    if (data?.type === 'active') return true;
    // No live session to compare with: nothing to narrow to.
    if (!liveSessionId) return true;
    const ids = [record.sessionOrigin, record.sessionId].filter(
      (id): id is string => typeof id === 'string' && !isUnscoped(id),
    );
    if (ids.length === 0) return true;
    return ids.some((id) => sameSession(id, liveSessionId));
  }

  if (filter.date) {
    for (const key of ['createdAt', 'timestamp', 'sessionOrigin', 'sessionId']) {
      const value = record[key];
      if (typeof value === 'string' && value.startsWith(filter.date)) return true;
    }
    return false;
  }

  return true;
}
