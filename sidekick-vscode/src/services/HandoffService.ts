/**
 * @fileoverview Session context handoff service.
 *
 * Generates slim, actionable handoff documents at session end so that
 * subsequent agent sessions can resume with context. Follows the
 * DecisionLogService pattern (storage in ~/.config/sidekick/).
 *
 * Storage location: ~/.config/sidekick/handoffs/
 *
 * @module services/HandoffService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionSummaryData } from '../types/sessionSummary';
import type { SessionAnalysisData } from '../types/analysis';
import type { SessionStats } from '../types/claudeSession';
import { buildHandoffMarkdown } from '../utils/handoffFormat';
import type { HandoffInput } from '../utils/handoffFormat';
import { log, logError } from './Logger';

/**
 * Service for generating and storing session context handoff documents.
 */
export class HandoffService implements vscode.Disposable {
  private handoffsDir: string;

  constructor(private readonly projectSlug: string) {
    this.handoffsDir = this.getHandoffsDir();
  }

  private getHandoffsDir(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'handoffs');
    }
    return path.join(os.homedir(), '.config', 'sidekick', 'handoffs');
  }

  /**
   * Ensures the handoffs directory exists.
   */
  async initialize(): Promise<void> {
    try {
      if (!fs.existsSync(this.handoffsDir)) {
        fs.mkdirSync(this.handoffsDir, { recursive: true });
        log(`HandoffService: Created handoffs directory: ${this.handoffsDir}`);
      }
    } catch (error) {
      logError('HandoffService: Failed to create handoffs directory', error);
    }
  }

  /**
   * Generates a handoff document from session data.
   *
   * Writes both a `-latest.md` (overwritten each time) and a timestamped copy.
   *
   * @returns Path to the latest handoff file
   */
  async generateHandoff(
    summary: SessionSummaryData,
    analysis: SessionAnalysisData,
    stats: SessionStats
  ): Promise<string> {
    await this.initialize();

    // Extract slim HandoffInput from the larger data objects
    const input = this.extractHandoffInput(summary, analysis, stats);
    const markdown = buildHandoffMarkdown(input);

    // Write latest (overwrite)
    const latestPath = path.join(this.handoffsDir, `${this.projectSlug}-latest.md`);
    await fs.promises.writeFile(latestPath, markdown, 'utf-8');
    log(`HandoffService: Wrote latest handoff to ${latestPath}`);

    // Write timestamped copy
    const dateStr = new Date().toISOString().slice(0, 10);
    const timestampedPath = path.join(this.handoffsDir, `${this.projectSlug}-${dateStr}.md`);
    await fs.promises.writeFile(timestampedPath, markdown, 'utf-8');
    log(`HandoffService: Wrote timestamped handoff to ${timestampedPath}`);

    return latestPath;
  }

  /**
   * Gets the path to the latest handoff file, or null if none exists.
   */
  getLatestHandoffPath(): string | null {
    const latestPath = path.join(this.handoffsDir, `${this.projectSlug}-latest.md`);
    return fs.existsSync(latestPath) ? latestPath : null;
  }

  /**
   * Reads the latest handoff file content, or null if none exists.
   */
  async readLatestHandoff(): Promise<string | null> {
    const latestPath = this.getLatestHandoffPath();
    if (!latestPath) return null;

    try {
      return await fs.promises.readFile(latestPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Extracts the slim HandoffInput from larger session data objects.
   */
  private extractHandoffInput(
    summary: SessionSummaryData,
    analysis: SessionAnalysisData,
    _stats: SessionStats
  ): HandoffInput {
    // Pending tasks: only unfinished ones
    const pendingTasks = summary.tasks
      .filter(t => t.status !== 'completed' && t.status !== 'done')
      .map(t => ({ name: t.subject, description: undefined }));

    // Files in progress: from summary's filesChanged (most recently modified)
    // Only include the last few files as "in progress"
    const filesInProgress = summary.filesChanged
      .slice(0, 10)
      .map(f => f.path);

    // Recovery patterns from analysis
    const recoveryPatterns = analysis.recoveryPatterns || [];

    // Failed commands: extract from errors that are command failures
    const failedCommands = analysis.errors
      .filter(e => e.category === 'exit_code' || e.category === 'command_failure')
      .flatMap(e => e.examples.slice(0, 2));

    return {
      projectPath: analysis.projectPath,
      date: new Date().toISOString(),
      duration: summary.duration,
      pendingTasks,
      filesInProgress,
      recoveryPatterns,
      failedCommands,
    };
  }

  dispose(): void {
    // No active timers or watchers to clean up
  }
}
