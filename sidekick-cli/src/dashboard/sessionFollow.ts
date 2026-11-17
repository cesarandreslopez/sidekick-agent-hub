/**
 * What the dashboard does when the project's session list changes.
 *
 * Only a session that did not exist before counts as new. Sessions that were
 * already there and are written to again (the user's chosen one, or a second
 * live one beside it) never move the dashboard: deciding on "newest by
 * modification time" made it jump to whichever session wrote last and back.
 */

export type SessionFollowDecision =
  | { action: 'none' }
  | { action: 'switch'; sessionPath: string }
  | { action: 'pending'; sessionPath: string };

export interface SessionFollowInput {
  /** The provider's sessions, newest first. */
  sessions: readonly string[];
  /** Every session path seen so far; updated in place with `sessions`. */
  known: Set<string>;
  /** The session the dashboard follows now, if any. */
  followed: string | undefined;
  /** Pinned: a new session is offered (pending) instead of followed. */
  pinned: boolean;
}

export function decideSessionFollow(input: SessionFollowInput): SessionFollowDecision {
  const fresh = input.sessions.filter((sessionPath) => !input.known.has(sessionPath));
  for (const sessionPath of input.sessions) input.known.add(sessionPath);
  // Newest first, so the first unseen path is the newest new session.
  const latest = fresh[0];
  if (!latest || latest === input.followed) return { action: 'none' };
  return input.pinned
    ? { action: 'pending', sessionPath: latest }
    : { action: 'switch', sessionPath: latest };
}
