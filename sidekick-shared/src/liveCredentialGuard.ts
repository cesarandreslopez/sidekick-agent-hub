/** Pure policy shared by provider-specific live credential installers. */
export type LiveCredentialWriteIntent = 'switch' | 'relogin' | 'repair' | 'rollback';
export type LiveCredentialWriteRefusal =
  | 'live-unreadable'
  | 'invalid-candidate'
  | 'same-account'
  | 'different-account'
  | 'same-link'
  | 'not-captured'
  | 'not-newer'
  | 'live-changed';
export type LiveCredentialWriteDecision =
  | { allow: true }
  | { allow: false; code: LiveCredentialWriteRefusal; reason: string };

export interface LiveCredentialWriteFacts {
  provider: string;
  intent: LiveCredentialWriteIntent;
  liveStatus: 'ok' | 'absent' | 'corrupt' | 'error';
  candidateValid: boolean;
  liveHasCredential: boolean;
  liveAccountId: string | null;
  candidateAccountId: string;
  sameLink: boolean;
  strictlyNewer: boolean;
  capturedOutgoing?: boolean;
  matchesWritten: boolean;
  /** Compatibility with Claude's established missing/corrupt rollback policy. */
  allowNonOkRollback?: boolean;
  rejectCorrupt?: boolean;
  requireDifferentLinkForAdvance?: boolean;
}

export function decideLiveCredentialWrite(
  f: LiveCredentialWriteFacts,
): LiveCredentialWriteDecision {
  const refuse = (
    code: LiveCredentialWriteRefusal,
    reason: string,
  ): LiveCredentialWriteDecision => ({ allow: false, code, reason });
  if (f.liveStatus === 'error' || (f.rejectCorrupt && f.liveStatus === 'corrupt')) {
    return refuse(
      'live-unreadable',
      `The live ${f.provider} login could not be read, so it was left untouched.`,
    );
  }
  if (f.intent === 'rollback') {
    return f.matchesWritten || (f.allowNonOkRollback && f.liveStatus !== 'ok')
      ? { allow: true }
      : refuse(
          'live-changed',
          `The live ${f.provider} login changed after the switch wrote it; it was kept.`,
        );
  }
  if (!f.candidateValid)
    return refuse('invalid-candidate', `The saved credential is not a ${f.provider} login.`);
  if (f.intent === 'switch') {
    if (f.liveAccountId !== null && f.liveAccountId === f.candidateAccountId) {
      return refuse('same-account', 'That account is already the live login.');
    }
    if (f.sameLink)
      return refuse(
        'same-link',
        'The saved login is the same refresh token the live login holds; sign in to that account again.',
      );
    if (f.liveHasCredential && !f.capturedOutgoing) {
      return refuse(
        'not-captured',
        'The outgoing live login was not saved first, so it was left untouched.',
      );
    }
    return { allow: true };
  }
  if (f.liveAccountId !== null && f.liveAccountId !== f.candidateAccountId) {
    return refuse(
      'different-account',
      `The live ${f.provider} login belongs to another account; switch accounts instead.`,
    );
  }
  if (!f.liveHasCredential) return { allow: true };
  if (!f.strictlyNewer || (f.requireDifferentLinkForAdvance && f.sameLink)) {
    return refuse(
      'not-newer',
      `The live ${f.provider} login is already at least as new; it was kept.`,
    );
  }
  return { allow: true };
}
