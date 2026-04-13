/**
 * @fileoverview Codex CLI session provider (VS Code wrapper).
 */

import { CodexProvider } from 'sidekick-shared/dist/providers/codex';
import {
  getActiveCodexAccount,
  quotaFromCodexRateLimits,
  writeQuotaSnapshot,
} from 'sidekick-shared';
import type { SessionProvider } from '../../types/sessionProvider';
import type { QuotaState } from '../../types/dashboard';

export class CodexSessionProvider extends CodexProvider implements SessionProvider {
  getQuotaFromSession(): QuotaState | null {
    const quota = quotaFromCodexRateLimits(this.getLastRateLimits());
    if (!quota) return null;

    const active = getActiveCodexAccount();
    if (active) {
      writeQuotaSnapshot('codex', active.id, quota);
    }

    return {
      ...quota,
      accountLabel: active?.label,
      accountDetail: active?.email,
    };
  }
}
