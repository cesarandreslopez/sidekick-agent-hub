/**
 * @fileoverview OpenCode session provider (VS Code wrapper).
 *
 * Thin wrapper around the shared OpenCodeProvider, adding only
 * vscode.Disposable compliance for the VS Code SessionProvider interface.
 *
 * All DB access, message parsing, and session logic lives in sidekick-shared.
 * Adds a `getQuotaFromSession()` override that surfaces the derived z.ai
 * coding-plan quota (when OpenCode is routing at z.ai) so the dashboard,
 * snapshot, and history pipelines see it without bespoke wiring.
 *
 * @module services/providers/OpenCodeSessionProvider
 */

import * as vscode from 'vscode';
import {
  OpenCodeProvider,
  appendQuotaHistorySample,
  writeQuotaSnapshot,
} from 'sidekick-shared';
import type { QuotaState } from 'sidekick-shared';
import type { ZaiTier } from 'sidekick-shared';
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
  /**
   * Returns the current z.ai coding-plan quota when OpenCode is routing at
   * z.ai, otherwise null. Invoked by `SessionMonitor` on each event batch,
   * so the dashboard + history pipelines see updates automatically.
   */
  getQuotaFromSession(): QuotaState | null {
    const tier = this.readConfiguredTier();
    const quota = this.getZaiQuotaState(tier);
    if (!quota) return null;

    writeQuotaSnapshot('zai', 'default', quota);
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

  private readConfiguredTier(): ZaiTier | 'auto' {
    const raw = vscode.workspace.getConfiguration('sidekick').get<string>('zai.tier', 'auto');
    if (raw === 'lite' || raw === 'pro' || raw === 'max') return raw;
    return 'auto';
  }
}

