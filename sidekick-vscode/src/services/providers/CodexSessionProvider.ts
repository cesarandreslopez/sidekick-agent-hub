/**
 * @fileoverview Codex CLI session provider (VS Code wrapper).
 */

import {
  CodexProvider,
  appendQuotaHistorySample,
  getActiveCodexAccount,
  readQuotaSnapshot,
  resolveActiveCodexAccount,
  quotaFromCodexRateLimits,
  writeQuotaSnapshot,
} from 'sidekick-shared';
import type { SessionProvider } from '../../types/sessionProvider';
import type { QuotaState } from '../../types/dashboard';
import { getWorkspaceId } from '../../utils/workspaceId';

export class CodexSessionProvider extends CodexProvider implements SessionProvider {
  getQuotaFromSession(): QuotaState | null {
    const quota = quotaFromCodexRateLimits(this.getLastRateLimits());
    if (!quota) return null;

    // Self-heal the saved active pointer to the live login, so the snapshot/history
    // key and the displayed account track the currently logged-in Codex account.
    resolveActiveCodexAccount();
    const active = getActiveCodexAccount();
    const cached = active ? readQuotaSnapshot('codex', active.id) : null;
    const quotaWithResetCredits = {
      ...quota,
      resetCredits: quota.resetCredits ?? cached?.resetCredits,
    };
    if (active) {
      writeQuotaSnapshot('codex', active.id, quotaWithResetCredits);
      const workspaceId = getWorkspaceId();
      if (workspaceId) {
        void appendQuotaHistorySample({
          timestamp: quotaWithResetCredits.capturedAt ?? new Date().toISOString(),
          runtimeProvider: 'codex',
          providerId: active.id,
          workspaceId,
          fiveHour: {
            utilization: quotaWithResetCredits.fiveHour.utilization,
            resetsAt: quotaWithResetCredits.fiveHour.resetsAt,
          },
          sevenDay: {
            utilization: quotaWithResetCredits.sevenDay.utilization,
            resetsAt: quotaWithResetCredits.sevenDay.resetsAt,
          },
          available: quotaWithResetCredits.available,
          error: quotaWithResetCredits.error,
          source: quotaWithResetCredits.source,
          stale: quotaWithResetCredits.stale,
        }).catch(() => {
          // History append must not poison the session quota path.
        });
      }
    }

    return {
      ...quotaWithResetCredits,
      accountLabel: active?.label,
      accountDetail: active?.email,
    };
  }
}
