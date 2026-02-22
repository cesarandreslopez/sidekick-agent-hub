/**
 * Shared provider interface and types for session providers.
 * Simplified from sidekick-vscode/src/types/sessionProvider.ts (no VS Code deps).
 */

export type ProviderId = 'claude-code' | 'opencode' | 'codex';

export interface SearchHit {
  sessionPath: string;
  line: string;
  eventType: string;
  timestamp: string;
  projectPath: string;
}

export interface SessionFileStats {
  providerId: ProviderId;
  sessionId: string;
  filePath: string;
  label: string | null;
  startTime: string;
  endTime: string;
  messageCount: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  modelUsage: Record<string, { calls: number; tokens: number }>;
  toolUsage: Record<string, number>;
  compactionEstimate: number;
  truncationCount: number;
  reportedCost: number;
}

export interface ProjectFolderInfo {
  dir: string;
  name: string;
  encodedName: string;
  sessionCount: number;
  lastModified: Date;
}

export interface SessionProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  findSessionFiles(workspacePath: string): string[];
  findAllSessions(workspacePath: string): string[];
  getProjectsBaseDir(): string;
  readSessionStats(sessionPath: string): SessionFileStats;
  extractSessionLabel(sessionPath: string): string | null;
  searchInSession(sessionPath: string, query: string, maxResults: number): SearchHit[];
  getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[];
  dispose(): void;
}
