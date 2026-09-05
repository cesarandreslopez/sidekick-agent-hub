/**
 * Initial data handed from the extension to the dashboard bundle.
 *
 * The template embeds a `DashboardInit` as JSON in a
 * `<script type="application/json">` block; the bundle parses it on load, so
 * the document carries no inline executable script.
 *
 * @module webview/dashboard/init
 */

import type { DashboardInit } from '../../types/dashboard';

export const DASHBOARD_INIT_ELEMENT_ID = 'sidekick-dashboard-init';

/** Minimal document surface, so the reader is testable without a DOM. */
export interface InitDocument {
  getElementById(id: string): { textContent: string | null } | null;
}

export function emptyDashboardInit(): DashboardInit {
  return {
    session: {
      groups: null,
      isPinned: false,
      isUsingCustomPath: false,
      customPathDisplay: null,
      providerId: 'claude-code',
      providerName: 'Claude Code',
    },
    changelog: [],
    attributionVars: {},
  };
}

/** Parse the embedded init block; a missing or malformed block yields the empty init. */
export function readDashboardInit(doc: InitDocument): DashboardInit {
  const text = doc.getElementById(DASHBOARD_INIT_ELEMENT_ID)?.textContent;
  if (!text) return emptyDashboardInit();
  try {
    const parsed = JSON.parse(text) as Partial<DashboardInit>;
    const empty = emptyDashboardInit();
    return {
      session: { ...empty.session, ...(parsed.session ?? {}) },
      changelog: Array.isArray(parsed.changelog) ? parsed.changelog : [],
      attributionVars: parsed.attributionVars ?? {},
    };
  } catch {
    return emptyDashboardInit();
  }
}
