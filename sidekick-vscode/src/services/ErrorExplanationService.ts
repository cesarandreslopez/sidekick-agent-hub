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
import type { ErrorContext, ErrorExplanation, FixSuggestion } from '../types/errorExplanation';
import type { ComplexityLevel } from '../types/rsvp';
import { getErrorExplanationPrompt, getErrorFixPrompt } from '../utils/prompts';

/**
 * ErrorExplanationService - AI-powered error explanations and fixes.
 *
 * Generates detailed explanations for error/warning diagnostics and suggests
 * code fixes using Claude. Uses configurable model (Sonnet default for accuracy).
 */
export class ErrorExplanationService {
  /**
   * Creates a new ErrorExplanationService.
   *
   * @param authService - AuthService instance for Claude API access
   */
  constructor(private authService: AuthService) {}

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
    try {
      // Read model from configuration (default: sonnet)
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = config.get<string>('errorModel') ?? 'sonnet';

      // Build prompt for error explanation
      const prompt = getErrorExplanationPrompt(code, errorContext, complexity);

      // Request explanation from Claude
      const response = await this.authService.complete(prompt, {
        model,
        maxTokens: 2000,
        timeout: 30000,
      });

      // Parse response into ErrorExplanation structure
      return this.parseExplanation(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to generate error explanation: ${message}`);
    }
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
    try {
      // Read model from configuration (default: sonnet)
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = config.get<string>('errorModel') ?? 'sonnet';

      // Build prompt for fix generation
      const prompt = getErrorFixPrompt(code, errorContext);

      // Request fix from Claude
      const fixedCode = await this.authService.complete(prompt, {
        model,
        maxTokens: 2000,
        timeout: 30000,
      });

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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to generate fix: ${message}`);
    }
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
    // Default structure in case parsing fails
    const explanation: ErrorExplanation = {
      rootCause: '',
      whyItHappens: '',
      suggestedFix: '',
    };

    // Try to split by section headers
    const rootCauseMatch = response.match(/ROOT CAUSE[:\s]+(.*?)(?=WHY IT HAPPENS|HOW TO FIX|$)/is);
    const whyItHappensMatch = response.match(/WHY IT HAPPENS[:\s]+(.*?)(?=ROOT CAUSE|HOW TO FIX|$)/is);
    const howToFixMatch = response.match(/HOW TO FIX[:\s]+(.*?)(?=ROOT CAUSE|WHY IT HAPPENS|$)/is);

    if (rootCauseMatch) {
      explanation.rootCause = rootCauseMatch[1].trim();
    }

    if (whyItHappensMatch) {
      explanation.whyItHappens = whyItHappensMatch[1].trim();
    }

    if (howToFixMatch) {
      explanation.suggestedFix = howToFixMatch[1].trim();
    }

    // If no sections found, treat entire response as root cause
    if (!explanation.rootCause && !explanation.whyItHappens && !explanation.suggestedFix) {
      explanation.rootCause = response.trim();
      explanation.whyItHappens = 'See explanation above.';
      explanation.suggestedFix = 'See explanation above.';
    }

    return explanation;
  }
}
