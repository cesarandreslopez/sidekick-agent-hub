/**
 * @fileoverview Provider-aware guidance advisor service.
 *
 * Orchestrates session data collection and AI analysis to generate
 * actionable suggestions for improving the active agent's instruction
 * file (CLAUDE.md or AGENTS.md depending on provider).
 *
 * @module services/GuidanceAdvisor
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import type { SessionAnalyzer, SessionAnalysisData } from './SessionAnalyzer';
import type { SessionMonitor } from './SessionMonitor';
import type { InstructionFileName, InstructionFileTarget } from '../types/instructionFile';
import { resolveInstructionTarget } from '../types/instructionFile';
import { buildGuidanceAnalysisPrompt, parseGuidanceSuggestions } from '../utils/analysisPrompts';
import { log, logError } from './Logger';

/**
 * A suggestion for improving the agent instruction file.
 */
export interface GuidanceSuggestion {
  /** Short descriptive title */
  title: string;
  /** What was observed in the session that led to this suggestion */
  observed: string;
  /** The exact text to add to the instruction file */
  suggestion: string;
  /** Why this suggestion would help */
  reasoning: string;
}

// Re-export under the old name for backward compatibility
export type ClaudeMdSuggestion = GuidanceSuggestion;

/**
 * Result of the analysis operation.
 */
export interface AnalysisResult {
  /** Whether the analysis was successful */
  success: boolean;
  /** Generated suggestions (empty if failed) */
  suggestions: GuidanceSuggestion[];
  /** Error message if failed */
  error?: string;
  /** The session data that was analyzed */
  sessionData?: SessionAnalysisData;
  /** The instruction file target used for this analysis */
  target?: InstructionFileTarget;
}

/**
 * Options for the analyze operation.
 */
export interface AnalyzeOptions {
  /** Override the default 90s timeout (milliseconds) */
  timeout?: number;
}

/**
 * Provider-aware guidance advisor for generating instruction file suggestions.
 *
 * Resolves the correct instruction file (CLAUDE.md or AGENTS.md) based on
 * the active session provider and generates targeted suggestions.
 *
 * @example
 * ```typescript
 * const advisor = new GuidanceAdvisor(authService, sessionAnalyzer, sessionMonitor);
 *
 * const result = await advisor.analyze();
 * if (result.success) {
 *   for (const suggestion of result.suggestions) {
 *     console.log(suggestion.title);
 *     console.log(suggestion.suggestion);
 *   }
 * }
 * ```
 */
export class GuidanceAdvisor {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionAnalyzer: SessionAnalyzer,
    private readonly sessionMonitor: SessionMonitor
  ) {}

  /**
   * Reads an instruction file from the workspace root.
   *
   * @param filename - The instruction file to read
   * @returns File content if it exists, null otherwise
   */
  private async readInstructionFile(filename: InstructionFileName): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      log('GuidanceAdvisor: No workspace folders found');
      return null;
    }

    const filePath = path.join(workspaceFolders[0].uri.fsPath, filename);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      log(`GuidanceAdvisor: Read ${filename} (${content.length} chars)`);
      return content;
    } catch {
      log(`GuidanceAdvisor: ${filename} not found or unreadable`);
      return null;
    }
  }

  /**
   * Analyzes the current session and generates instruction file suggestions.
   *
   * @param options - Optional analysis configuration
   * @returns Analysis result with suggestions or error
   */
  async analyze(options?: AnalyzeOptions): Promise<AnalysisResult> {
    const providerId = this.sessionMonitor.getProvider().id;
    const target = resolveInstructionTarget(providerId);
    log(`GuidanceAdvisor: Starting analysis targeting ${target.primaryFile} (provider: ${providerId})`);

    try {
      // 1. Collect session data
      const sessionData = this.sessionAnalyzer.collectData();
      log(`GuidanceAdvisor: Collected data - ${sessionData.toolPatterns.length} tool patterns, ${sessionData.errors.length} error types, ${sessionData.inefficiencies.length} inefficiencies`);

      // 2. Read both instruction files
      const primaryContent = await this.readInstructionFile(target.primaryFile);
      const secondaryContent = await this.readInstructionFile(target.secondaryFile);

      // Map to session data fields
      if (target.primaryFile === 'CLAUDE.md') {
        sessionData.currentClaudeMd = primaryContent ?? undefined;
        sessionData.currentAgentsMd = secondaryContent ?? undefined;
      } else {
        sessionData.currentAgentsMd = primaryContent ?? undefined;
        sessionData.currentClaudeMd = secondaryContent ?? undefined;
      }

      // 3. Check if we have enough data for meaningful analysis
      if (!sessionData.hasEnoughData) {
        log('GuidanceAdvisor: Not enough session data for analysis');
        return {
          success: false,
          suggestions: [],
          error: 'Not enough session data for analysis. Try using your agent more before analyzing.',
          sessionData,
          target
        };
      }

      // 4. Build the analysis prompt
      const prompt = buildGuidanceAnalysisPrompt(sessionData, target);
      log(`GuidanceAdvisor: Built prompt (${prompt.length} chars)`);

      // 5. Call inference provider
      log('GuidanceAdvisor: Calling inference provider for analysis');
      const model = resolveModel('balanced', this.authService.getProviderId(), 'explanationModel');
      const timeout = options?.timeout ?? 90000;
      const response = await this.authService.complete(prompt, {
        model,
        timeout
      });
      log(`GuidanceAdvisor: Received response (${response.length} chars)`);

      // 6. Parse the response into structured suggestions
      const suggestions = parseGuidanceSuggestions(response);
      log(`GuidanceAdvisor: Parsed ${suggestions.length} suggestions`);

      if (suggestions.length === 0) {
        logError('GuidanceAdvisor: No suggestions parsed from response');
        return {
          success: false,
          suggestions: [],
          error: 'Could not parse suggestions from the analysis. The response may have been in an unexpected format.',
          sessionData,
          target
        };
      }

      return {
        success: true,
        suggestions,
        sessionData,
        target
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logError('GuidanceAdvisor: Analysis failed', error);

      return {
        success: false,
        suggestions: [],
        error: `Analysis failed: ${message}`,
        target
      };
    }
  }

  /**
   * Checks if the session has enough data for meaningful analysis.
   *
   * @returns True if analysis would be meaningful
   */
  hasEnoughData(): boolean {
    const sessionData = this.sessionAnalyzer.collectData();
    return sessionData.hasEnoughData;
  }
}

// Re-export under the old name for backward compatibility
export { GuidanceAdvisor as ClaudeMdAdvisor };
