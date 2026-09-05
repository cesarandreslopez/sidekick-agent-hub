/**
 * The typed modules the legacy dashboard script delegates to; built in
 * index.ts and handed to `startLegacyDashboard`.
 */

import type { HealthView } from './health';
import type { HistoryView } from './history';

export interface LegacyHelpers {
  history: HistoryView;
  health: HealthView;
}
