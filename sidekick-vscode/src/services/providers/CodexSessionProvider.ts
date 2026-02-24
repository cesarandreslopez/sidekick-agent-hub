/**
 * @fileoverview Codex CLI session provider (VS Code wrapper).
 *
 * Thin wrapper around the shared CodexProvider, adding only
 * vscode.Disposable compliance and getQuotaFromSession() which
 * converts raw rate limits to the VS Code dashboard's QuotaState format.
 *
 * All rollout parsing, DB access, and session logic lives in sidekick-shared.
 *
 * @module services/providers/CodexSessionProvider
 */

import { CodexProvider } from 'sidekick-shared/dist/providers/codex';
import type { SessionProvider } from '../../types/sessionProvider';
import type { QuotaState } from '../../types/dashboard';

/**
 * Session provider for Codex CLI (VS Code integration).
 *
 * Inherits all functionality from the shared CodexProvider.
 * Adds getQuotaFromSession() to convert Codex rate_limits data
 * into the QuotaState format used by the VS Code dashboard.
 */
export class CodexSessionProvider extends CodexProvider implements SessionProvider {
  /**
   * Gets subscription quota state from the latest rate_limits data.
   * Codex emits rate_limits in token_count events with primary (5-hour)
   * and secondary (7-day) windows.
   */
  getQuotaFromSession(): QuotaState | null {
    const rateLimits = this.getLastRateLimits();
    if (!rateLimits) return null;

    const { primary, secondary } = rateLimits;
    if (!primary || !secondary) return null;

    return {
      fiveHour: {
        utilization: primary.used_percent,
        resetsAt: new Date(primary.resets_at * 1000).toISOString(),
      },
      sevenDay: {
        utilization: secondary.used_percent,
        resetsAt: new Date(secondary.resets_at * 1000).toISOString(),
      },
      available: true,
    };
  }
}
