/**
 * @fileoverview ExplanationService - Adaptive explanation generation.
 *
 * ExplanationService generates explanations tailored to content type (prose/technical/code)
 * and complexity level (ELI5 to PhD). Uses configurable model (Sonnet default).
 *
 * @module ExplanationService
 */

import * as vscode from 'vscode';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import type { ContentType, ComplexityLevel } from '../types/explain';

/**
 * ExplanationService - Adaptive explanation generation.
 *
 * Generates explanations tailored to content type (prose/technical/code)
 * and complexity level (ELI5 to PhD). Uses configurable model (Sonnet default).
 */
export class ExplanationService {
  private timeoutManager: TimeoutManager;

  /**
   * Creates a new ExplanationService.
   *
   * @param authService - AuthService instance for Claude API access
   */
  constructor(private authService: AuthService) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generate explanation for text.
   *
   * Creates adaptive prompts based on content type and complexity level,
   * using the configured model (default: Sonnet).
   *
   * @param text - Content to explain
   * @param contentType - Classification result (prose/technical/code)
   * @param complexity - User-selected complexity level
   * @param fileContext - Optional file context (fileName, languageId)
   * @param extraInstructions - Optional extra instructions for regeneration
   * @returns Promise resolving to explanation text
   * @throws Error if explanation generation fails
   */
  async explain(
    text: string,
    contentType: ContentType,
    complexity: ComplexityLevel,
    fileContext?: { fileName: string; languageId: string },
    extraInstructions?: string
  ): Promise<string> {
    // Read model from configuration (default: sonnet)
    const config = vscode.workspace.getConfiguration('sidekick');
    const model = resolveModel(config.get<string>('explanationModel') ?? 'auto', this.authService.getProviderId(), 'explanationModel');

    // Build adaptive prompt
    const prompt = this.buildPrompt(text, contentType, complexity, fileContext, extraInstructions);
    const contextSize = new TextEncoder().encode(prompt).length;

    // Get timeout config for this operation
    const timeoutConfig = this.timeoutManager.getTimeoutConfig('explanation');

    // Execute with timeout management and retry support
    const opLabel = `Generating explanation via ${this.authService.getProviderDisplayName()} · ${model}`;
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
      return result.result;
    }

    if (result.timedOut) {
      throw new Error(`Explanation timed out after ${result.timeoutMs}ms`);
    }

    const message = result.error?.message ?? 'Unknown error';
    throw new Error(`Failed to generate explanation: ${message}`);
  }

  /**
   * Build adaptive prompt based on content type and complexity level.
   *
   * @param text - Content to explain
   * @param contentType - Classification result
   * @param complexity - User-selected complexity level
   * @param fileContext - Optional file context
   * @param extraInstructions - Optional extra instructions for regeneration
   * @returns Formatted prompt string
   */
  private buildPrompt(
    text: string,
    contentType: ContentType,
    complexity: ComplexityLevel,
    fileContext?: { fileName: string; languageId: string },
    extraInstructions?: string
  ): string {
    const audienceContext = this.getAudienceContext(complexity);
    const contentGuidance = this.getContentGuidance(contentType);

    // Add file context if available
    const fileInfo = fileContext
      ? `\nSource: ${fileContext.fileName} (${fileContext.languageId})`
      : '';

    // Add extra instructions if provided (for regeneration)
    const extraGuidance = extraInstructions
      ? `\n\nAdditional instructions from the user: ${extraInstructions}`
      : '';

    return `You are explaining ${contentType} content to ${audienceContext}.${fileInfo}

${contentGuidance}${extraGuidance}

Content to explain:
<content>
${text}
</content>

Provide a clear, concise explanation appropriate for the audience level. Use markdown formatting for readability.`;
  }

  /**
   * Get audience context description for complexity level.
   *
   * @param complexity - User-selected complexity level
   * @returns Audience description for prompt
   */
  private getAudienceContext(complexity: ComplexityLevel): string {
    switch (complexity) {
      case 'eli5':
        return 'a complete beginner with no background knowledge. Use simple analogies and avoid jargon entirely';
      case 'curious-amateur':
        return 'someone learning the topic. Explain key concepts clearly and define technical terms';
      case 'imposter-syndrome':
        return 'someone with partial knowledge who wants to fill gaps. Assume basic familiarity, explain intermediate concepts';
      case 'senior':
        return 'an experienced professional. Provide high-level summary, highlight important details, skip basics';
      case 'phd':
        return 'an expert. Provide dense, technical analysis without dumbing down. Discuss nuances and implications';
    }
  }

  /**
   * Get content-specific guidance for content type.
   *
   * @param contentType - Classification result
   * @returns Content-specific guidance for prompt
   */
  private getContentGuidance(contentType: ContentType): string {
    switch (contentType) {
      case 'prose':
        return 'Summarize the main narrative or argument. Highlight key themes and important details.';
      case 'technical':
        return 'Explain the technical concepts and how they relate. Clarify terminology and significance.';
      case 'code':
        return 'Explain what the code does, its purpose, key logic, and any notable patterns or techniques used.';
    }
  }
}
