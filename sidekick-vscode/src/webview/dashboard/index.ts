/**
 * Dashboard webview entry point (bundled to `out/webview/dashboard.js`).
 *
 * Reads the init block the template embeds and starts the (still untyped)
 * legacy dashboard script. Typed features are added as modules beside
 * `legacy.ts` and wired from here.
 */

import { createHistoryView } from './history';
import { readDashboardInit } from './init';
import { startLegacyDashboard } from './legacy';

startLegacyDashboard(readDashboardInit(document), { history: createHistoryView(document) });
