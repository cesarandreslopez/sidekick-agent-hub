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
import { decideLiveCredentialWrite } from './liveCredentialGuard';
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

export function decideLiveClaudeWrite(request: LiveClaudeWriteRequest): LiveClaudeWriteDecision {
  const candidate = parseClaudeCredentialBlob(request.candidate);
  const live = request.live.status === 'ok' ? parseClaudeCredentialBlob(request.live.blob) : null;
  const liveFp = claudeRefreshFingerprint(live);
  return decideLiveCredentialWrite({
    provider: 'Claude',
    intent: request.intent,
    liveStatus: request.live.status,
    candidateValid: candidate !== null,
    liveHasCredential: live !== null,
    liveAccountId: request.liveAccountUuid,
    candidateAccountId: request.candidateAccountUuid,
    sameLink: liveFp !== null && liveFp === claudeRefreshFingerprint(candidate),
    strictlyNewer: claudeCredentialFreshness(candidate) > claudeCredentialFreshness(live),
    capturedOutgoing: request.capturedOutgoing,
    matchesWritten:
      request.live.status === 'ok' &&
      JSON.stringify(request.live.blob) === JSON.stringify(request.written),
    allowNonOkRollback: true,
    requireDifferentLinkForAdvance: true,
  });
}
