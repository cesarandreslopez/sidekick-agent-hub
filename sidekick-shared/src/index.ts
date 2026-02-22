/**
 * Public API for sidekick-shared.
 */

// Types
export type { PersistedTask, TaskPersistenceStore, TaskStatus } from './types/taskPersistence';
export { TASK_PERSISTENCE_SCHEMA_VERSION } from './types/taskPersistence';
export type { DecisionEntry, DecisionLogStore, DecisionSource } from './types/decisionLog';
export { DECISION_LOG_SCHEMA_VERSION } from './types/decisionLog';
export type { KnowledgeNote, KnowledgeNoteStore, KnowledgeNoteType, KnowledgeNoteSource, KnowledgeNoteStatus, KnowledgeNoteImportance } from './types/knowledgeNote';
export { KNOWLEDGE_NOTE_SCHEMA_VERSION, IMPORTANCE_DECAY_FACTORS, STALENESS_THRESHOLDS } from './types/knowledgeNote';
export type { HistoricalDataStore, DailyData, MonthlyData, AllTimeStats, TokenTotals, ModelUsageRecord, ToolUsageRecord, SessionSummary } from './types/historicalData';
export { HISTORICAL_DATA_SCHEMA_VERSION, createEmptyTokenTotals } from './types/historicalData';

// Paths
export { getConfigDir, getProjectDataPath, getGlobalDataPath, encodeWorkspacePath, getProjectSlug, getProjectSlugRaw } from './paths';

// Readers
export { readTasks } from './readers/tasks';
export type { ReadTasksOptions } from './readers/tasks';
export { readDecisions } from './readers/decisions';
export type { ReadDecisionsOptions } from './readers/decisions';
export { readNotes } from './readers/notes';
export type { ReadNotesOptions } from './readers/notes';
export { readHistory } from './readers/history';
export { readLatestHandoff } from './readers/handoff';

// Providers
export type { ProviderId, SessionProvider, SessionFileStats, SearchHit, ProjectFolderInfo } from './providers/types';
export { detectProvider, getAllDetectedProviders } from './providers/detect';
export { ClaudeCodeProvider } from './providers/claudeCode';
export { OpenCodeProvider } from './providers/openCode';
export { CodexProvider } from './providers/codex';

// Search
export { searchSessions } from './search/sessionSearch';
export type { SearchResult } from './search/sessionSearch';

// Context
export { composeContext } from './context/composer';
export type { Fidelity, ContextResult } from './context/composer';

// Watchers
export type { FollowEvent, FollowEventType, SessionWatcher, SessionWatcherCallbacks } from './watchers/types';
export { createWatcher } from './watchers/factory';
export type { CreateWatcherOptions } from './watchers/factory';
