/**
 * The typed modules the legacy dashboard script delegates to; built in
 * index.ts and handed to `startLegacyDashboard`.
 */

import type { DashboardNavigation } from './navigation';
import type { HealthView } from './health';
import type { HistoryView } from './history';

export interface LegacyHelpers {
  navigation: DashboardNavigation;
  history: HistoryView;
  health: HealthView;
}
