/**
 * Compatibility re-export. The durable historical-data schema is canonical in
 * sidekick-shared so the extension and CLI compile against one definition.
 */
export {
  HISTORICAL_DATA_SCHEMA_VERSION,
  HISTORICAL_SESSION_RETENTION_LIMIT,
  createEmptyDataStore,
  createEmptyTokenTotals,
} from 'sidekick-shared';
export type {
  AllTimeStats,
  DailyData,
  HistoricalDataStore,
  HourlyData,
  ModelUsageRecord,
  MonthlyData,
  SessionHistoryRecord,
  SessionSummary,
  TokenTotals,
  ToolUsageRecord,
} from 'sidekick-shared';
