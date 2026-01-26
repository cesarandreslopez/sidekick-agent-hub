/**
 * Explain Selection - Type Definitions
 *
 * Shared types between extension and webview for inline code explanation.
 * Provides type-safe message passing for AI-powered code explanations.
 */

import { ComplexityLevel } from './rsvp';

/**
 * File context for code explanations
 * Provides language hints for better prompt generation
 */
export interface FileContext {
  fileName: string;
  languageId: string;
}

/**
 * Webview state for Explain panel.
 * Persisted via vscode.setState() to survive hide/show cycles.
 */
export interface ExplainState {
  code: string;                      // Selected code to explain
  fileContext?: FileContext;         // File name and language for context
  currentExplanation?: string;       // AI-generated explanation (markdown)
  complexity: ComplexityLevel;       // Current explanation depth
  isLoading: boolean;                // AI request in progress
  error?: string;                    // Error message if request failed
}

/**
 * Messages sent from extension to webview
 */
export type ExplainExtensionMessage =
  | { type: 'loadCode'; code: string; fileContext?: FileContext }
  | { type: 'explanationResult'; requestId: string; explanation: string }
  | { type: 'explanationError'; requestId: string; error: string }
  | { type: 'complexityChanged'; complexity: ComplexityLevel };

/**
 * Messages sent from webview to extension
 */
export type ExplainWebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'requestExplanation'; requestId: string; code: string; complexity: ComplexityLevel; fileContext?: FileContext }
  | { type: 'changeComplexity'; complexity: ComplexityLevel }
  | { type: 'openInRsvp'; explanation: string }
  | { type: 'close' };

/**
 * Default initial state for Explain panel
 */
export const DEFAULT_EXPLAIN_STATE: ExplainState = {
  code: '',
  complexity: 'imposter-syndrome',
  isLoading: false,
};
