/**
 * @fileoverview ErrorExplanationService - AI-powered error explanations and fixes.
 *
 * ErrorExplanationService generates explanations for error diagnostics and
 * suggests code fixes using the configured model (Sonnet default).
 *
 * @module ErrorExplanationService
 */

import * as vscode from 'vscode';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import type { ErrorContext, ErrorExplanation, FixSuggestion } from '../types/errorExplanation';
import type { ComplexityLevel } from '../types/explain';
import { getErrorExplanationPrompt, getErrorFixPrompt } from '../utils/prompts';

/**
 * ErrorExplanationService - AI-powered error explanations and fixes.
 *
 * Generates detailed explanations for error/warning diagnostics and suggests
 * code fixes using Claude. Uses configurable model (Sonnet default for accuracy).
 */
export class ErrorExplanationService {
  private readonly timeoutManager: TimeoutManager;

  /**
   * Creates a new ErrorExplanationService.
   *
   * @param authService - AuthService instance for Claude API access
   */
  constructor(private authService: AuthService) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generate explanation for an error diagnostic.
   *
   * Creates structured explanation with root cause, why it happens, and
   * suggested fix using the configured model (default: Sonnet).
   *
   * @param code - The code snippet containing the error
   * @param errorContext - Context about the error (message, code, location, etc.)
   * @param complexity - Optional complexity level for explanation depth
   * @returns Promise resolving to structured error explanation
   * @throws Error if explanation generation fails
   */
  async explainError(
    code: string,
    errorContext: ErrorContext,
    complexity?: ComplexityLevel
  ): Promise<ErrorExplanation> {
    // Read model from configuration (default: sonnet)
    const config = vscode.workspace.getConfiguration('sidekick');
    const model = resolveModel(config.get<string>('errorModel') ?? 'auto', this.authService.getProviderId(), 'errorModel');

    // Build prompt for error explanation
    const prompt = getErrorExplanationPrompt(code, errorContext, complexity);
    const contextSize = new TextEncoder().encode(prompt).length;
    const timeoutConfig = this.timeoutManager.getTimeoutConfig('errorExplanation');

    // Execute with timeout management and retry support
    const opLabel = `Explaining error via ${this.authService.getProviderDisplayName()} · ${model}`;
    const result = await this.timeoutManager.executeWithTimeout({
      operation: opLabel,
      task: (signal: AbortSignal) => this.authService.complete(prompt, {
        model,
        maxTokens: 2000,
        signal,
      }),
      config: timeoutConfig,
      contextSize,
      showProgress: true,
      cancellable: true,
      onTimeout: (timeoutMs: number, contextKb: number) =>
        this.timeoutManager.promptRetry(opLabel, timeoutMs, contextKb),
    });

    if (result.success && result.result !== undefined) {
      return this.parseExplanation(result.result);
    }

    if (result.timedOut) {
      throw new Error(`Error explanation timed out after ${result.timeoutMs}ms`);
    }

    const message = result.error?.message ?? 'Unknown error';
    throw new Error(`Failed to generate error explanation: ${message}`);
  }

  /**
   * Generate fix suggestion for an error diagnostic.
   *
   * Attempts to generate fixed code that resolves the error. Returns null
   * if a fix cannot be determined.
   *
   * @param code - The code snippet containing the error
   * @param errorContext - Context about the error (message, code, location, etc.)
   * @returns Promise resolving to fix suggestion or null if unfixable
   * @throws Error if fix generation fails
   */
  async generateFix(
    code: string,
    errorContext: ErrorContext
  ): Promise<FixSuggestion | null> {
    // Read model from configuration (default: sonnet)
    const config = vscode.workspace.getConfiguration('sidekick');
    const model = resolveModel(config.get<string>('errorModel') ?? 'auto', this.authService.getProviderId(), 'errorModel');

    // Build prompt for fix generation
    const prompt = getErrorFixPrompt(code, errorContext);
    const contextSize = new TextEncoder().encode(prompt).length;
    const timeoutConfig = this.timeoutManager.getTimeoutConfig('errorExplanation');

    // Execute with timeout management and retry support
    const fixLabel = `Generating fix via ${this.authService.getProviderDisplayName()} · ${model}`;
    const result = await this.timeoutManager.executeWithTimeout({
      operation: fixLabel,
      task: (signal: AbortSignal) => this.authService.complete(prompt, {
        model,
        maxTokens: 2000,
        signal,
      }),
      config: timeoutConfig,
      contextSize,
      showProgress: true,
      cancellable: true,
      onTimeout: (timeoutMs: number, contextKb: number) =>
        this.timeoutManager.promptRetry(fixLabel, timeoutMs, contextKb),
    });

    if (!result.success) {
      if (result.timedOut) {
        throw new Error(`Fix generation timed out after ${result.timeoutMs}ms`);
      }
      const message = result.error?.message ?? 'Unknown error';
      throw new Error(`Failed to generate fix: ${message}`);
    }

    const fixedCode = result.result!;

    // If response is empty or looks like refusal, return null
    if (!fixedCode || fixedCode.trim().length === 0) {
      return null;
    }

    // Check if Claude refused to fix (common meta-response patterns)
    const lowerResponse = fixedCode.toLowerCase();
    if (
      lowerResponse.includes('cannot') ||
      lowerResponse.includes('unable to') ||
      lowerResponse.includes('need more context')
    ) {
      return null;
    }

    // Build FixSuggestion from response
    return {
      documentUri: errorContext.fileName,
      range: errorContext.range,
      originalCode: code,
      fixedCode: fixedCode.trim(),
      explanation: `Fixed ${errorContext.severity}: ${errorContext.errorMessage}`,
    };
  }

  /**
   * Parse explanation response into structured ErrorExplanation.
   *
   * Looks for section headers (ROOT CAUSE, WHY IT HAPPENS, HOW TO FIX)
   * and extracts content for each section.
   *
   * @param response - Raw response text from Claude
   * @returns Structured ErrorExplanation object
   */
  private parseExplanation(response: string): ErrorExplanation {
    // Try to split by section headers
    const rootCause = response.match(/ROOT CAUSE[:\s]+(.*?)(?=WHY IT HAPPENS|HOW TO FIX|$)/is)?.[1]?.trim() ?? '';
    const whyItHappens = response.match(/WHY IT HAPPENS[:\s]+(.*?)(?=ROOT CAUSE|HOW TO FIX|$)/is)?.[1]?.trim() ?? '';
    const suggestedFix = response.match(/HOW TO FIX[:\s]+(.*?)(?=ROOT CAUSE|WHY IT HAPPENS|$)/is)?.[1]?.trim() ?? '';

    // If no sections found, treat entire response as root cause
    if (!rootCause && !whyItHappens && !suggestedFix) {
      return {
        rootCause: response.trim(),
        whyItHappens: 'See explanation above.',
        suggestedFix: 'See explanation above.',
      };
    }

    return { rootCause, whyItHappens, suggestedFix };
  }
}
