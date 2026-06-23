/**
 * @fileoverview OpenCode session provider (VS Code wrapper).
 *
 * Thin wrapper around the shared OpenCodeProvider, adding only
 * vscode.Disposable compliance for the VS Code SessionProvider interface.
 *
 * All DB access, message parsing, and session logic lives in sidekick-shared.
 * Adds a `getQuotaFromSession()` override that surfaces z.ai Coding Plan
 * quota when API credentials are available or OpenCode is routing at z.ai,
 * so the dashboard, snapshot, and history pipelines see it without bespoke
 * wiring.
 *
 * @module services/providers/OpenCodeSessionProvider
 */

import { OpenCodeProvider, appendQuotaHistorySample, resolveZaiQuota } from 'sidekick-shared';
import type { QuotaState } from 'sidekick-shared';
import type { SessionProvider } from '../../types/sessionProvider';
import { getWorkspaceId } from '../../utils/workspaceId';

/**
 * Session provider for OpenCode CLI (VS Code integration).
 *
 * Inherits all functionality from the shared OpenCodeProvider, including
 * DB-backed reading, file-based fallback, context attribution, and
 * usage snapshot support.
 */
export class OpenCodeSessionProvider extends OpenCodeProvider implements SessionProvider {
  private static readonly ZAI_QUOTA_REFRESH_INTERVAL_MS = 60_000;

  private lastZaiQuotaFetchMs = 0;
  private lastZaiQuota: QuotaState | null = null;
  private pendingZaiQuota: Promise<QuotaState | null> | null = null;

  /**
   * Returns the current z.ai coding-plan quota when credentials or z.ai
   * routing are present, otherwise null. Invoked by `SessionMonitor` on each
   * event batch, so the dashboard + history pipelines see updates
   * automatically.
   */
  async getQuotaFromSession(): Promise<QuotaState | null> {
    const now = Date.now();
    if (
      this.lastZaiQuota &&
      now - this.lastZaiQuotaFetchMs < OpenCodeSessionProvider.ZAI_QUOTA_REFRESH_INTERVAL_MS
    ) {
      return this.lastZaiQuota;
    }

    if (this.pendingZaiQuota) return this.pendingZaiQuota;

    this.pendingZaiQuota = this.fetchAndRecordZaiQuota().finally(() => {
      this.pendingZaiQuota = null;
    });
    return this.pendingZaiQuota;
  }

  private async fetchAndRecordZaiQuota(): Promise<QuotaState | null> {
    const routingActive = this.isZaiRoutingActive();
    const quota = await resolveZaiQuota();
    if (!quota.available && !quota.stale && !routingActive) {
      return null;
    }

    this.lastZaiQuota = quota;
    this.lastZaiQuotaFetchMs = Date.now();
    const workspaceId = getWorkspaceId();
    if (workspaceId) {
      void appendQuotaHistorySample({
        timestamp: quota.capturedAt ?? new Date().toISOString(),
        runtimeProvider: 'zai',
        providerId: 'default',
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

    return quota;
  }
}
