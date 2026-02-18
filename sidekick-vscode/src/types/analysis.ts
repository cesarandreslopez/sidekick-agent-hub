/**
 * @fileoverview Type definitions for session analysis.
 *
 * Shared types used by both SessionAnalyzer service and analysisPrompts utils.
 *
 * @module types/analysis
 */

/**
 * Categorized error from session data.
 */
export interface AnalyzedError {
  /** Error category (permission, not_found, syntax, timeout, exit_code, tool_error, other) */
  category: string;
  /** Number of occurrences */
  count: number;
  /** Example error messages (up to 3) */
  examples: string[];
}

/**
 * Tool usage pattern from session data.
 */
export interface ToolPattern {
  /** Tool name */
  tool: string;
  /** Total number of calls */
  callCount: number;
  /** Failure rate (0-1) */
  failureRate: number;
  /** Files/paths accessed 3+ times */
  repeatedTargets: string[];
}

/**
 * Detected inefficiency in tool usage.
 */
export interface Inefficiency {
  /** Inefficiency type */
  type: 'repeated_read' | 'glob_overlap' | 'retry_loop' | 'command_failure' | 'search_spam';
  /** Human-readable description */
  description: string;
  /** Number of occurrences */
  occurrences: number;
}

/**
 * Recovery pattern detected when Claude finds a workaround after a failure.
 *
 * Examples:
 * - npm install fails -> pnpm install succeeds
 * - File not found at /src/foo.ts -> found at /lib/foo.ts
 * - git pull fails -> git fetch && git merge succeeds
 */
export interface RecoveryPattern {
  /** Type of recovery pattern */
  type: 'command_fallback' | 'path_alternative' | 'tool_retry' | 'approach_switch';
  /** Human-readable description of the recovery */
  description: string;
  /** What didn't work */
  failedApproach: string;
  /** What worked instead */
  successfulApproach: string;
  /** How many times this pattern occurred */
  occurrences: number;
}

/**
 * Structured session data for CLAUDE.md analysis.
 */
export interface SessionAnalysisData {
  /** Error patterns from the session */
  errors: AnalyzedError[];

  /** Tool usage patterns */
  toolPatterns: ToolPattern[];

  /** Detected inefficiencies */
  inefficiencies: Inefficiency[];

  /** Recovery patterns where Claude found workarounds after failures */
  recoveryPatterns: RecoveryPattern[];

  /** Recent activity summary (last 20 events) */
  recentActivity: string[];

  /** Session duration in milliseconds */
  sessionDuration: number;

  /** Total tokens used (input + output) */
  totalTokens: number;

  /** Project path being worked on */
  projectPath: string;

  /** Whether there's enough data for meaningful analysis */
  hasEnoughData: boolean;

  /** Current CLAUDE.md content if it exists */
  currentClaudeMd?: string;

  /** Current AGENTS.md content if it exists */
  currentAgentsMd?: string;
}
