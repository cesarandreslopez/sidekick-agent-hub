/**
 * @fileoverview Session data analyzer for CLAUDE.md suggestions.
 *
 * Collects and structures session data (errors, tool patterns, inefficiencies)
 * from SessionMonitor for AI-powered analysis that generates CLAUDE.md suggestions.
 *
 * @module services/SessionAnalyzer
 */

import * as path from 'path';
import type { SessionMonitor } from './SessionMonitor';
import type { ToolCall, ToolAnalytics, TimelineEvent } from '../types/claudeSession';

// Re-export analysis types so existing consumers don't break
export type { AnalyzedError, ToolPattern, Inefficiency, RecoveryPattern, SessionAnalysisData } from '../types/analysis';
import type { AnalyzedError, ToolPattern, Inefficiency, RecoveryPattern, SessionAnalysisData } from '../types/analysis';

/**
 * Analyzes session data to generate structured input for CLAUDE.md suggestions.
 *
 * Extracts patterns from SessionMonitor data including:
 * - Error patterns and their frequencies
 * - Tool usage patterns and repeated targets
 * - Inefficiencies like repeated file reads or search spam
 *
 * @example
 * ```typescript
 * const analyzer = new SessionAnalyzer(sessionMonitor);
 * const data = analyzer.collectData();
 * // data can be passed to ClaudeMdAdvisor for AI analysis
 * ```
 */
export class SessionAnalyzer {
  /** Cached analysis data */
  private _cachedData: SessionAnalysisData | null = null;

  /** Timestamp of last cache update */
  private _cacheTimestamp: number = 0;

  /** Cache TTL in milliseconds (30 seconds) */
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly sessionMonitor: SessionMonitor) {}

  /**
   * Returns cached analysis data if fresh (< 30s old), otherwise collects new data.
   *
   * @returns Cached or freshly computed session analysis data
   */
  getCachedData(): SessionAnalysisData {
    const now = Date.now();
    if (this._cachedData && (now - this._cacheTimestamp) < SessionAnalyzer.CACHE_TTL_MS) {
      return this._cachedData;
    }
    this._cachedData = this.collectData();
    this._cacheTimestamp = now;
    return this._cachedData;
  }

  /**
   * Collects and structures session data for analysis.
   *
   * @returns Structured session data for CLAUDE.md analysis
   */
  collectData(): SessionAnalysisData {
    const stats = this.sessionMonitor.getStats();

    const errors = this.extractErrors(stats.errorDetails);
    const toolPatterns = this.extractToolPatterns(stats.toolAnalytics, stats.toolCalls);
    const inefficiencies = this.detectInefficiencies(stats.toolCalls);
    const recoveryPatterns = this.detectRecoveryPatterns(stats.toolCalls);
    const recentActivity = this.summarizeTimeline(stats.timeline);

    const sessionDuration = stats.sessionStartTime
      ? Date.now() - stats.sessionStartTime.getTime()
      : 0;

    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;

    // Get project path from session monitor
    const sessionPath = this.sessionMonitor.getSessionPath();
    const projectPath = this.extractProjectPath(sessionPath);

    // Determine if we have enough data for meaningful analysis
    const hasEnoughData = stats.toolCalls.length >= 5 ||
      errors.length > 0 ||
      totalTokens > 1000;

    return {
      errors,
      toolPatterns,
      inefficiencies,
      recoveryPatterns,
      recentActivity,
      sessionDuration,
      totalTokens,
      projectPath,
      hasEnoughData,
    };
  }

  /**
   * Detects recovery patterns where Claude found workarounds after failures.
   *
   * Looks for sequences where a tool call fails and a subsequent call
   * of the same tool type succeeds with a similar-but-different approach.
   *
   * @param toolCalls - All tool calls in session
   * @returns Array of detected recovery patterns
   */
  private detectRecoveryPatterns(toolCalls: ToolCall[]): RecoveryPattern[] {
    const patternMap = new Map<string, RecoveryPattern>();

    // Sort by timestamp (chronological)
    const sorted = [...toolCalls].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Look for failure → success sequences
    for (let i = 0; i < sorted.length; i++) {
      const failed = sorted[i];
      if (!failed.isError) continue;

      // Look for recovery in next N calls of same tool
      const lookAhead = 5;
      for (let j = i + 1; j < Math.min(i + lookAhead, sorted.length); j++) {
        const candidate = sorted[j];
        if (candidate.name !== failed.name) continue;
        if (candidate.isError) continue;

        // Check if this is a related recovery
        const recovery = this.matchRecoveryPattern(failed, candidate);
        if (recovery) {
          const key = `${recovery.type}:${recovery.failedApproach}→${recovery.successfulApproach}`;
          const existing = patternMap.get(key);
          if (existing) {
            existing.occurrences++;
          } else {
            patternMap.set(key, recovery);
          }
          break; // Found recovery for this failure
        }
      }
    }

    return Array.from(patternMap.values())
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  /**
   * Attempts to match a failed and successful tool call as a recovery pattern.
   *
   * @param failed - The failed tool call
   * @param succeeded - The successful tool call
   * @returns RecoveryPattern if a pattern is detected, null otherwise
   */
  private matchRecoveryPattern(failed: ToolCall, succeeded: ToolCall): RecoveryPattern | null {
    switch (failed.name) {
      case 'Bash':
        return this.matchBashRecovery(failed, succeeded);
      case 'Read':
      case 'Write':
      case 'Edit':
        return this.matchFilePathRecovery(failed, succeeded);
      case 'Glob':
      case 'Grep':
        return this.matchSearchRecovery(failed, succeeded);
      default:
        return this.matchGenericRecovery(failed, succeeded);
    }
  }

  /**
   * Matches Bash command recovery patterns.
   *
   * Detects:
   * - Package manager switches (npm → pnpm, pip → pip3)
   * - Command alternatives (git pull → git fetch && git merge)
   * - Flag variations (same command with different flags)
   *
   * @param failed - Failed Bash call
   * @param succeeded - Successful Bash call
   * @returns RecoveryPattern or null
   */
  private matchBashRecovery(failed: ToolCall, succeeded: ToolCall): RecoveryPattern | null {
    const failedCmd = String(failed.input.command || '').trim();
    const succeededCmd = String(succeeded.input.command || '').trim();

    if (!failedCmd || !succeededCmd || failedCmd === succeededCmd) return null;

    // Extract base command (first word)
    const failedBase = failedCmd.split(/\s+/)[0];
    const succeededBase = succeededCmd.split(/\s+/)[0];

    // Package manager switches
    const packageManagers = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'poetry', 'pipenv'];
    if (packageManagers.includes(failedBase) && packageManagers.includes(succeededBase)) {
      // Extract operation (install, add, etc.) and packages
      const failedParts = failedCmd.split(/\s+/);
      const succeededParts = succeededCmd.split(/\s+/);

      // Normalize operations
      const normalizeOp = (op: string) => {
        if (['install', 'add', 'i'].includes(op)) return 'install';
        if (['uninstall', 'remove', 'rm'].includes(op)) return 'uninstall';
        return op;
      };

      const failedOp = normalizeOp(failedParts[1] || '');
      const succeededOp = normalizeOp(succeededParts[1] || '');

      if (failedOp === succeededOp) {
        return {
          type: 'command_fallback',
          description: `Use ${succeededBase} instead of ${failedBase}`,
          failedApproach: this.truncateCommand(failedCmd),
          successfulApproach: this.truncateCommand(succeededCmd),
          occurrences: 1
        };
      }
    }

    // Git command alternatives
    if (failedBase === 'git' && succeededBase === 'git') {
      const failedGitCmd = failedCmd.split(/\s+/)[1] || '';
      const succeededGitCmd = succeededCmd.split(/\s+/)[1] || '';

      // Different git subcommands that accomplish similar goals
      const gitAliases: Record<string, string[]> = {
        'pull': ['fetch', 'merge', 'rebase'],
        'checkout': ['switch', 'restore'],
        'reset': ['restore', 'checkout'],
      };

      if (gitAliases[failedGitCmd]?.includes(succeededGitCmd) ||
          gitAliases[succeededGitCmd]?.includes(failedGitCmd)) {
        return {
          type: 'command_fallback',
          description: `Use "${succeededCmd.split(/\s+/).slice(0, 3).join(' ')}" instead of "${failedCmd.split(/\s+/).slice(0, 3).join(' ')}"`,
          failedApproach: this.truncateCommand(failedCmd),
          successfulApproach: this.truncateCommand(succeededCmd),
          occurrences: 1
        };
      }
    }

    // Same base command with different flags/arguments (retry with modifications)
    if (failedBase === succeededBase) {
      return {
        type: 'tool_retry',
        description: `Modified ${failedBase} command succeeded`,
        failedApproach: this.truncateCommand(failedCmd),
        successfulApproach: this.truncateCommand(succeededCmd),
        occurrences: 1
      };
    }

    return null;
  }

  /**
   * Matches file path recovery patterns.
   *
   * Detects when a file is found in a different location than initially tried.
   *
   * @param failed - Failed file operation
   * @param succeeded - Successful file operation
   * @returns RecoveryPattern or null
   */
  private matchFilePathRecovery(failed: ToolCall, succeeded: ToolCall): RecoveryPattern | null {
    const failedPath = String(failed.input.file_path || '');
    const succeededPath = String(succeeded.input.file_path || '');

    if (!failedPath || !succeededPath || failedPath === succeededPath) return null;

    // Extract filename (last path component)
    const failedFilename = path.basename(failedPath);
    const succeededFilename = path.basename(succeededPath);

    // Same filename in different directory
    if (failedFilename === succeededFilename) {
      const failedDir = path.dirname(failedPath);
      const succeededDir = path.dirname(succeededPath);

      return {
        type: 'path_alternative',
        description: `${failedFilename} is in ${this.shortenPath(succeededDir)}, not ${this.shortenPath(failedDir)}`,
        failedApproach: this.shortenPath(failedPath),
        successfulApproach: this.shortenPath(succeededPath),
        occurrences: 1
      };
    }

    // Similar filename (e.g., config.js vs config.ts)
    const failedBasename = failedFilename.replace(/\.[^.]+$/, '');
    const succeededBasename = succeededFilename.replace(/\.[^.]+$/, '');

    if (failedBasename === succeededBasename) {
      const failedExt = path.extname(failedFilename);
      const succeededExt = path.extname(succeededFilename);

      return {
        type: 'path_alternative',
        description: `Use ${succeededFilename} (${succeededExt}) instead of ${failedFilename} (${failedExt})`,
        failedApproach: this.shortenPath(failedPath),
        successfulApproach: this.shortenPath(succeededPath),
        occurrences: 1
      };
    }

    return null;
  }

  /**
   * Matches search pattern recovery (Glob/Grep).
   *
   * Detects when a search succeeds with a different pattern.
   *
   * @param failed - Failed search call
   * @param succeeded - Successful search call
   * @returns RecoveryPattern or null
   */
  private matchSearchRecovery(failed: ToolCall, succeeded: ToolCall): RecoveryPattern | null {
    const failedPattern = String(failed.input.pattern || '');
    const succeededPattern = String(succeeded.input.pattern || '');

    if (!failedPattern || !succeededPattern || failedPattern === succeededPattern) return null;

    // Look for patterns that search for similar things
    // This is heuristic - patterns that share significant substrings
    const failedKeywords = this.extractPatternKeywords(failedPattern);
    const succeededKeywords = this.extractPatternKeywords(succeededPattern);

    const sharedKeywords = failedKeywords.filter(k => succeededKeywords.includes(k));

    if (sharedKeywords.length > 0) {
      return {
        type: 'approach_switch',
        description: `Search pattern "${this.truncatePattern(succeededPattern)}" worked instead of "${this.truncatePattern(failedPattern)}"`,
        failedApproach: failedPattern,
        successfulApproach: succeededPattern,
        occurrences: 1
      };
    }

    return null;
  }

  /**
   * Generic recovery pattern matching for other tools.
   *
   * @param failed - Failed tool call
   * @param succeeded - Successful tool call
   * @returns RecoveryPattern or null
   */
  private matchGenericRecovery(failed: ToolCall, succeeded: ToolCall): RecoveryPattern | null {
    // For generic tools, just note that a retry with different input worked
    const failedInputStr = JSON.stringify(failed.input);
    const succeededInputStr = JSON.stringify(succeeded.input);

    if (failedInputStr === succeededInputStr) return null;

    return {
      type: 'tool_retry',
      description: `${failed.name} succeeded with different parameters`,
      failedApproach: this.summarizeInput(failed.input),
      successfulApproach: this.summarizeInput(succeeded.input),
      occurrences: 1
    };
  }

  /**
   * Extracts keywords from a search pattern for similarity comparison.
   *
   * @param pattern - Search pattern (glob or grep)
   * @returns Array of keywords
   */
  private extractPatternKeywords(pattern: string): string[] {
    // Remove glob/regex special characters and split into words
    return pattern
      .replace(/[*?[\]{}()\\^$.|+]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .map(w => w.toLowerCase());
  }

  /**
   * Truncates a command for display.
   *
   * @param cmd - Full command
   * @returns Truncated command (max 60 chars)
   */
  private truncateCommand(cmd: string): string {
    if (cmd.length <= 60) return cmd;
    return cmd.substring(0, 57) + '...';
  }

  /**
   * Truncates a pattern for display.
   *
   * @param pattern - Full pattern
   * @returns Truncated pattern (max 40 chars)
   */
  private truncatePattern(pattern: string): string {
    if (pattern.length <= 40) return pattern;
    return pattern.substring(0, 37) + '...';
  }

  /**
   * Shortens a file path for display.
   *
   * @param filePath - Full file path
   * @returns Shortened path (last 2-3 components)
   */
  private shortenPath(filePath: string): string {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length <= 3) return filePath;
    return '.../' + parts.slice(-3).join('/');
  }

  /**
   * Summarizes tool input for display.
   *
   * @param input - Tool input object
   * @returns Brief summary string
   */
  private summarizeInput(input: Record<string, unknown>): string {
    const keys = Object.keys(input);
    if (keys.length === 0) return '(empty)';

    const firstKey = keys[0];
    const firstValue = String(input[firstKey] || '');

    if (firstValue.length > 40) {
      return `${firstKey}: ${firstValue.substring(0, 37)}...`;
    }
    return `${firstKey}: ${firstValue}`;
  }

  /**
   * Extracts and categorizes errors from session data.
   *
   * @param errorDetails - Error details map from SessionStats
   * @returns Array of analyzed errors
   */
  private extractErrors(errorDetails: Map<string, string[]>): AnalyzedError[] {
    const errors: AnalyzedError[] = [];

    for (const [category, messages] of errorDetails) {
      errors.push({
        category,
        count: messages.length,
        examples: messages.slice(0, 3)
      });
    }

    // Sort by count descending
    errors.sort((a, b) => b.count - a.count);

    return errors;
  }

  /**
   * Extracts tool usage patterns from analytics and call history.
   *
   * @param toolAnalytics - Per-tool analytics map
   * @param toolCalls - All tool calls in session
   * @returns Array of tool patterns
   */
  private extractToolPatterns(
    toolAnalytics: Map<string, ToolAnalytics>,
    toolCalls: ToolCall[]
  ): ToolPattern[] {
    const patterns: ToolPattern[] = [];

    // Count targets per tool for repeated access detection
    const targetCounts = new Map<string, Map<string, number>>();

    for (const call of toolCalls) {
      if (!targetCounts.has(call.name)) {
        targetCounts.set(call.name, new Map());
      }
      const target = this.extractTarget(call);
      if (target) {
        const toolTargets = targetCounts.get(call.name)!;
        toolTargets.set(target, (toolTargets.get(target) || 0) + 1);
      }
    }

    for (const [name, analytics] of toolAnalytics) {
      const totalCalls = analytics.successCount + analytics.failureCount;
      if (totalCalls === 0) continue;

      const failureRate = analytics.failureCount / totalCalls;

      // Find repeated targets (accessed 3+ times)
      const repeatedTargets: string[] = [];
      const toolTargets = targetCounts.get(name);
      if (toolTargets) {
        for (const [target, count] of toolTargets) {
          if (count >= 3) {
            repeatedTargets.push(`${path.basename(target)} (${count}x)`);
          }
        }
      }

      patterns.push({
        tool: name,
        callCount: totalCalls,
        failureRate,
        repeatedTargets: repeatedTargets.slice(0, 5) // Limit to 5
      });
    }

    // Sort by call count descending
    patterns.sort((a, b) => b.callCount - a.callCount);

    return patterns;
  }

  /**
   * Detects inefficiencies in tool usage patterns.
   *
   * @param toolCalls - All tool calls in session
   * @returns Array of detected inefficiencies
   */
  private detectInefficiencies(toolCalls: ToolCall[]): Inefficiency[] {
    const inefficiencies: Inefficiency[] = [];

    // Detect repeated reads (same file 3+ times)
    const readCounts = new Map<string, number>();
    for (const call of toolCalls.filter(c => c.name === 'Read')) {
      const filePath = call.input.file_path as string;
      if (filePath) {
        readCounts.set(filePath, (readCounts.get(filePath) || 0) + 1);
      }
    }
    for (const [filePath, count] of readCounts) {
      if (count >= 3) {
        inefficiencies.push({
          type: 'repeated_read',
          description: `${path.basename(filePath)} read ${count} times`,
          occurrences: count
        });
      }
    }

    // Detect Bash command failures (same command type failing repeatedly)
    const bashFailures = new Map<string, number>();
    for (const call of toolCalls.filter(c => c.name === 'Bash')) {
      const command = call.input.command as string;
      if (command) {
        // Extract the base command (first word)
        const baseCommand = command.trim().split(/\s+/)[0];
        // This is an approximation - we'd need tool_result data for actual failures
        // For now, count the command types
        bashFailures.set(baseCommand, (bashFailures.get(baseCommand) || 0) + 1);
      }
    }

    // Detect search spam (many Glob/Grep calls in short window)
    const searchCalls = toolCalls.filter(c => c.name === 'Glob' || c.name === 'Grep');
    if (searchCalls.length >= 10) {
      // Check for overlapping patterns
      const patterns = new Set<string>();
      for (const call of searchCalls) {
        const pattern = (call.input.pattern as string) || (call.input.path as string);
        if (pattern) {
          patterns.add(pattern);
        }
      }
      if (searchCalls.length > patterns.size * 2) {
        inefficiencies.push({
          type: 'search_spam',
          description: `${searchCalls.length} search calls with ${patterns.size} unique patterns`,
          occurrences: searchCalls.length
        });
      }
    }

    // Detect glob overlap (similar glob patterns)
    const globCalls = toolCalls.filter(c => c.name === 'Glob');
    if (globCalls.length >= 5) {
      const globPatterns = globCalls.map(c => c.input.pattern as string).filter(Boolean);
      const similarPatterns = this.findSimilarPatterns(globPatterns);
      if (similarPatterns.length > 0) {
        inefficiencies.push({
          type: 'glob_overlap',
          description: `Multiple similar glob patterns: ${similarPatterns.slice(0, 3).join(', ')}`,
          occurrences: similarPatterns.length
        });
      }
    }

    return inefficiencies;
  }

  /**
   * Summarizes timeline events for analysis prompt.
   *
   * @param timeline - Timeline events (most recent first)
   * @returns Array of summarized activity strings (last 20 events)
   */
  private summarizeTimeline(timeline: TimelineEvent[]): string[] {
    return timeline.slice(0, 20).map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      return `[${time}] ${event.type}: ${event.description}`;
    });
  }

  /**
   * Extracts the target (file path, pattern, etc.) from a tool call.
   *
   * @param call - Tool call
   * @returns Target string or undefined
   */
  private extractTarget(call: ToolCall): string | undefined {
    switch (call.name) {
      case 'Read':
      case 'Write':
      case 'Edit':
        return call.input.file_path as string;
      case 'Glob':
      case 'Grep':
        return call.input.pattern as string;
      case 'Bash':
        return call.input.command as string;
      default:
        return undefined;
    }
  }

  /**
   * Extracts project path from session file path.
   *
   * Session paths are like: ~/.claude/projects/-home-user-project/session.jsonl
   * We need to decode back to: /home/user/project
   *
   * @param sessionPath - Path to session JSONL file
   * @returns Decoded project path or 'Unknown'
   */
  private extractProjectPath(sessionPath: string | null): string {
    if (!sessionPath) return 'Unknown';

    try {
      // Extract the directory name that contains the session
      const sessionDir = path.dirname(sessionPath);
      const encodedPath = path.basename(sessionDir);

      // Decode: -home-user-project -> /home/user/project
      if (encodedPath.startsWith('-')) {
        return encodedPath.replace(/-/g, '/');
      }

      return encodedPath || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  /**
   * Finds similar glob patterns that might indicate inefficient searching.
   *
   * @param patterns - Array of glob patterns
   * @returns Array of similar pattern groups
   */
  private findSimilarPatterns(patterns: string[]): string[] {
    const similar: string[] = [];

    // Group patterns by their base directory
    const byDir = new Map<string, string[]>();
    for (const pattern of patterns) {
      const dir = path.dirname(pattern) || '.';
      if (!byDir.has(dir)) {
        byDir.set(dir, []);
      }
      byDir.get(dir)!.push(pattern);
    }

    // Find directories with multiple patterns
    for (const [dir, dirPatterns] of byDir) {
      if (dirPatterns.length >= 3) {
        similar.push(`${dir}/* (${dirPatterns.length} patterns)`);
      }
    }

    return similar;
  }
}
