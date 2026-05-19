/**
 * @fileoverview Codex CLI session provider (VS Code wrapper).
 */

import {
  CodexProvider,
  appendQuotaHistorySample,
  getActiveCodexAccount,
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

    const active = getActiveCodexAccount();
    if (active) {
      writeQuotaSnapshot('codex', active.id, quota);
      const workspaceId = getWorkspaceId();
      if (workspaceId) {
        void appendQuotaHistorySample({
          timestamp: quota.capturedAt ?? new Date().toISOString(),
          runtimeProvider: 'codex',
          providerId: active.id,
          workspaceId,
          fiveHour: { utilization: quota.fiveHour.utilization, resetsAt: quota.fiveHour.resetsAt },
          sevenDay: { utilization: quota.sevenDay.utilization, resetsAt: quota.sevenDay.resetsAt },
          available: quota.available,
          error: quota.error,
          source: quota.source,
          stale: quota.stale,
        }).catch(() => {
          // History append must not poison the session quota path.
        });
      }
    }

    return {
      ...quota,
      accountLabel: active?.label,
      accountDetail: active?.email,
    };
  }
}
