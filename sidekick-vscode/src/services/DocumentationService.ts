/**
 * @fileoverview Service for AI-powered documentation generation.
 *
 * Generates JSDoc, docstrings, and other documentation formats
 * using Claude via the AuthService.
 *
 * @module DocumentationService
 */

import * as vscode from 'vscode';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import {
  getDocGenerationSystemPrompt,
  getDocGenerationUserPrompt,
  cleanDocResponse,
} from '../utils/prompts';
import { log, logError } from './Logger';

/**
 * Result from documentation generation.
 */
export interface DocumentationResult {
  /** Generated documentation text, or undefined if generation failed */
  documentation?: string;
  /** Line number where documentation should be inserted, or undefined if failed */
  insertLine?: number;
  /** Error message if generation failed */
  error?: string;
}

/**
 * Service for generating code documentation using Claude AI.
 *
 * This service:
 * - Detects functions/classes at cursor position or uses selected code
 * - Generates language-appropriate documentation (JSDoc, PEP 257, etc.)
 * - Handles indentation automatically
 * - Checks for existing documentation to avoid duplicates
 * - Provides detailed error handling
 *
 * @example
 * ```typescript
 * const service = new DocumentationService(authService);
 * const result = await service.generateDocumentation(editor);
 * if (result.documentation) {
 *   // Insert documentation at result.insertLine
 * } else if (result.error) {
 *   console.error(`Error: ${result.error}`);
 * }
 * ```
 */
export class DocumentationService implements vscode.Disposable {
  private readonly timeoutManager: TimeoutManager;

  /**
   * Creates a new DocumentationService.
   *
   * @param authService - Auth service for Claude API access
   */
  constructor(private authService: AuthService) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generates documentation for code at the current cursor position or selection.
   *
   * If code is selected, generates documentation for the selection.
   * If no selection, attempts to detect a function or class at the cursor position.
   *
   * @param editor - The active text editor
   * @returns Promise resolving to result with documentation text and insert position, or error
   */
  async generateDocumentation(editor: vscode.TextEditor): Promise<DocumentationResult> {
    const document = editor.document;
    const selection = editor.selection;
    const language = document.languageId;

    // Get code to document: selection or detect function at cursor
    let code: string;
    let insertLine: number;

    if (!selection.isEmpty) {
      // Use selected code
      code = document.getText(selection);
      insertLine = selection.start.line;
    } else {
      // Detect function/class at cursor position
      const detected = this.detectCodeBlock(document, selection.active.line);
      if (!detected) {
        return { error: 'Could not detect a function or class at cursor position. Try selecting the code to document.' };
      }
      code = detected.code;
      insertLine = detected.startLine;
    }

    // Check if documentation already exists
    if (insertLine > 0) {
      const lineAbove = document.lineAt(insertLine - 1).text.trim();
      if (lineAbove.endsWith('*/') || lineAbove.endsWith('"""') || lineAbove.endsWith("'''")) {
        return { error: 'Documentation already exists above this code block.' };
      }
    }

    try {
      log(`Generating documentation for ${language} code (${code.length} chars)`);

      const config = vscode.workspace.getConfiguration('sidekick');
      const model = resolveModel(config.get<string>('docModel') ?? 'auto', this.authService.getProviderId(), 'docModel');

      const systemPrompt = getDocGenerationSystemPrompt(language);
      const userPrompt = getDocGenerationUserPrompt(code, language);
      const fullPrompt = systemPrompt + '\n\n' + userPrompt;

      // Calculate context size for timeout scaling
      const contextSize = new TextEncoder().encode(fullPrompt).length;
      const timeoutConfig = this.timeoutManager.getTimeoutConfig('documentation');

      // Execute with timeout management and retry support
      const opLabel = `Generating documentation via ${this.authService.getProviderDisplayName()} · ${model}`;
      const timeoutResult = await this.timeoutManager.executeWithTimeout({
        operation: opLabel,
        task: (signal: AbortSignal) => this.authService.complete(fullPrompt, {
          model,
          maxTokens: 1024,
          signal,
        }),
        config: timeoutConfig,
        contextSize,
        showProgress: true,
        cancellable: true,
        onTimeout: (timeoutMs: number, contextKb: number) =>
          this.timeoutManager.promptRetry(opLabel, timeoutMs, contextKb),
      });

      if (!timeoutResult.success) {
        if (timeoutResult.timedOut) {
          return { error: `Request timed out after ${timeoutResult.timeoutMs}ms. Try again or increase timeout in settings.` };
        }
        if (timeoutResult.error?.name === 'AbortError') {
          return { error: 'Request cancelled' };
        }
        return { error: timeoutResult.error?.message ?? 'Unknown error' };
      }

      const result = timeoutResult.result!;
      const cleaned = cleanDocResponse(result, language);
      if (!cleaned) {
        return { error: 'Could not generate valid documentation. Please try again.' };
      }

      // Add proper indentation based on the target line
      const targetLine = document.lineAt(insertLine);
      const indent = targetLine.text.match(/^(\s*)/)?.[1] ?? '';
      const indentedDoc = this.indentDocumentation(cleaned, indent, language);

      return {
        documentation: indentedDoc + '\n',
        insertLine,
      };
    } catch (error) {
      logError('Documentation generation failed', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { error: message };
    }
  }

  /**
   * Detects a function, method, or class definition at or near the given line.
   *
   * Searches the current line and nearby lines for function/class declarations
   * using language-specific patterns.
   *
   * @param document - The text document to search
   * @param lineNumber - The line number to start searching from
   * @returns Object with code text and start line, or null if not found
   */
  private detectCodeBlock(document: vscode.TextDocument, lineNumber: number): { code: string; startLine: number } | null {
    const language = document.languageId;

    // Language-specific patterns for function/class detection
    const patterns: Record<string, RegExp> = {
      typescript: /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const\s+\w+\s*=\s*(async\s+)?\(|const\s+\w+\s*=\s*(async\s+)?function)/,
      javascript: /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s+)?\(|const\s+\w+\s*=\s*(async\s+)?function)/,
      python: /^\s*(async\s+)?(def|class)\s+\w+/,
    };

    const pattern = patterns[language];
    if (!pattern) {
      // For unsupported languages, try generic function/class pattern
      const genericPattern = /^\s*(function|class|def|fn|func|sub|procedure)\s+\w+/i;
      return this.findCodeBlockWithPattern(document, lineNumber, genericPattern);
    }

    return this.findCodeBlockWithPattern(document, lineNumber, pattern);
  }

  /**
   * Finds a code block using a regex pattern, searching current line and nearby lines.
   *
   * Searches up to 5 lines above and 3 lines below the cursor to find
   * function/class declarations.
   *
   * @param document - The text document to search
   * @param lineNumber - The line number to start searching from
   * @param pattern - The regex pattern to match function/class declarations
   * @returns Object with code text and start line, or null if not found
   */
  private findCodeBlockWithPattern(
    document: vscode.TextDocument,
    lineNumber: number,
    pattern: RegExp
  ): { code: string; startLine: number } | null {
    // Search current line and up to 5 lines above
    for (let i = lineNumber; i >= Math.max(0, lineNumber - 5); i--) {
      const lineText = document.lineAt(i).text;
      if (pattern.test(lineText)) {
        // Found function/class start, now find its extent
        const code = this.extractCodeBlock(document, i);
        return { code, startLine: i };
      }
    }

    // Also search a few lines below (in case cursor is above function)
    for (let i = lineNumber + 1; i <= Math.min(document.lineCount - 1, lineNumber + 3); i++) {
      const lineText = document.lineAt(i).text;
      if (pattern.test(lineText)) {
        const code = this.extractCodeBlock(document, i);
        return { code, startLine: i };
      }
    }

    return null;
  }

  /**
   * Extracts a reasonable code block starting from the given line.
   *
   * Gets enough context for documentation (signature + a few lines of body).
   * Handles language-specific block detection (braces for JS/TS, indentation for Python).
   *
   * @param document - The text document to extract from
   * @param startLine - The line number where the code block starts
   * @returns The extracted code as a string
   */
  private extractCodeBlock(document: vscode.TextDocument, startLine: number): string {
    const lines: string[] = [];
    const startIndent = document.lineAt(startLine).firstNonWhitespaceCharacterIndex;
    let braceDepth = 0;
    let parenDepth = 0;
    let foundBody = false;

    for (let i = startLine; i < Math.min(document.lineCount, startLine + 30); i++) {
      const line = document.lineAt(i).text;
      lines.push(line);

      // Track brace/paren depth for JS/TS
      for (const char of line) {
        if (char === '{') { braceDepth++; foundBody = true; }
        if (char === '}') braceDepth--;
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth--;
      }

      // For Python, detect end by indentation decrease
      if (document.languageId === 'python' && i > startLine) {
        const currentIndent = line.trim() ? document.lineAt(i).firstNonWhitespaceCharacterIndex : -1;
        if (currentIndent !== -1 && currentIndent <= startIndent && !line.trim().startsWith('#')) {
          // Back to same or lower indent, we've left the block
          lines.pop();
          break;
        }
      }

      // For JS/TS, end when we close the opening brace
      if (foundBody && braceDepth === 0 && parenDepth === 0) {
        break;
      }

      // Safety limit: if we have signature + some body, that's enough
      if (lines.length >= 15) break;
    }

    return lines.join('\n');
  }

  /**
   * Applies proper indentation to the generated documentation.
   *
   * For Python docstrings, all lines get the same indent.
   * For JSDoc, maintains the indent structure of the comment.
   *
   * @param doc - The documentation text to indent
   * @param indent - The indentation string (spaces/tabs) to apply
   * @param language - The programming language
   * @returns The indented documentation string
   */
  private indentDocumentation(doc: string, indent: string, _language: string): string {
    return doc.split('\n').map(line => indent + line).join('\n');
  }

  /**
   * Disposes of all resources.
   *
   * Implements vscode.Disposable for proper cleanup.
   */
  dispose(): void {
    // No resources to clean up currently
  }
}
