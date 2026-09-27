/**
 * The decision every write into the live Claude credential store must pass.
 * Pure: callers read the stores, this decides.
 *
 * Claude Code rotates the refresh token on every refresh, so the live store
 * always holds the newest link of its chain. Writing an older link over it
 * destroys a working login, and installing another account without saving the
 * live one first loses that account's chain. The rules:
 *
 * - `switch`: another account replaces live. Allowed only after the outgoing
 *   live credential was captured (whenever live holds one), and never with a
 *   candidate that is the same refresh-token link as live.
 * - `relogin` / `repair`: the same account's credential replaces live. Allowed
 *   only when the candidate is strictly fresher (a different refresh token
 *   with a later expiry); otherwise live is kept.
 * - `rollback`: restore what a failed switch displaced. Allowed only while the
 *   live store still holds exactly what that switch wrote (or is empty or
 *   unparseable); a write Claude Code made in between is never clobbered.
 * - An unreadable live store (`error`: timeout, locked Keychain) refuses all.
 */
import {
  claudeCredentialFreshness,
  claudeRefreshFingerprint,
  parseClaudeCredentialBlob,
} from './claudeCredentials';

export type LiveClaudeWriteIntent = 'switch' | 'relogin' | 'repair' | 'rollback';

/** The live store as read just before the write. */
export type LiveClaudeStoreState =
  | { status: 'ok'; blob: unknown }
  | { status: 'absent' }
  | { status: 'corrupt' }
  | { status: 'error' };

export interface LiveClaudeWriteRequest {
  intent: LiveClaudeWriteIntent;
  live: LiveClaudeStoreState;
  /** Account uuid of the live identity (`oauthAccount`), null when logged out. */
  liveAccountUuid: string | null;
  candidate: unknown;
  candidateAccountUuid: string;
  /** `switch`: the outgoing live credential was saved and verified. */
  capturedOutgoing?: boolean;
  /** `rollback`: the blob the failed switch wrote. */
  written?: unknown;
}

export type LiveClaudeWriteRefusal =
  | 'live-unreadable'
  | 'invalid-candidate'
  | 'same-account'
  | 'different-account'
  | 'same-link'
  | 'not-captured'
  | 'not-newer'
  | 'live-changed';

export type LiveClaudeWriteDecision =
  | { allow: true }
  | { allow: false; code: LiveClaudeWriteRefusal; reason: string };

function refuse(code: LiveClaudeWriteRefusal, reason: string): LiveClaudeWriteDecision {
  return { allow: false, code, reason };
}

export function decideLiveClaudeWrite(request: LiveClaudeWriteRequest): LiveClaudeWriteDecision {
  const { intent, live } = request;
  if (live.status === 'error') {
    return refuse(
      'live-unreadable',
      'The live Claude login could not be read, so it was left untouched.',
    );
  }

  if (intent === 'rollback') {
    if (live.status !== 'ok') return { allow: true };
    return JSON.stringify(live.blob) === JSON.stringify(request.written)
      ? { allow: true }
      : refuse(
          'live-changed',
          'The live Claude login changed after the switch wrote it; it was kept.',
        );
  }

  const candidate = parseClaudeCredentialBlob(request.candidate);
  if (!candidate) {
    return refuse('invalid-candidate', 'The saved credential is not a Claude login.');
  }
  const liveCredentials = live.status === 'ok' ? parseClaudeCredentialBlob(live.blob) : null;
  const liveFingerprint = claudeRefreshFingerprint(liveCredentials);
  const sameLink =
    liveFingerprint !== null && liveFingerprint === claudeRefreshFingerprint(candidate);

  if (intent === 'switch') {
    if (
      request.liveAccountUuid !== null &&
      request.liveAccountUuid === request.candidateAccountUuid
    ) {
      return refuse('same-account', 'That account is already the live login.');
    }
    if (sameLink) {
      return refuse(
        'same-link',
        'The saved login is the same refresh token the live login holds; sign in to that account again.',
      );
    }
    if (liveCredentials && !request.capturedOutgoing) {
      return refuse(
        'not-captured',
        'The outgoing live login was not saved first, so it was left untouched.',
      );
    }
    return { allow: true };
  }

  // relogin / repair: the same account, and only forward in time.
  if (
    request.liveAccountUuid !== null &&
    request.liveAccountUuid !== request.candidateAccountUuid
  ) {
    return refuse(
      'different-account',
      'The live Claude login belongs to another account; switch accounts instead.',
    );
  }
  if (!liveCredentials) return { allow: true };
  if (
    sameLink ||
    claudeCredentialFreshness(candidate) <= claudeCredentialFreshness(liveCredentials)
  ) {
    return refuse('not-newer', 'The live Claude login is already at least as new; it was kept.');
  }
  return { allow: true };
}
