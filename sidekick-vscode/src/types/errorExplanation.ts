/**
 * Error/Diagnostic Explanations - Type Definitions
 *
 * Shared types between extension and webview for error explanations and fixes.
 * Provides type-safe message passing for AI-powered error diagnostics.
 */

import { FileContext } from './explain';

/**
 * Context for an error diagnostic
 * Extends FileContext with diagnostic-specific metadata
 */
export interface ErrorContext extends FileContext {
  errorMessage: string;                // Diagnostic message text
  errorCode: string | undefined;       // Error code (e.g., "TS2322", "E0001")
  severity: 'error' | 'warning';       // Mapped from DiagnosticSeverity
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

/**
 * AI-generated explanation for an error
 */
export interface ErrorExplanation {
  rootCause: string;                   // What's actually wrong
  whyItHappens: string;                // Common scenario explanation
  suggestedFix: string;                // Plain text fix description
  fixedCode?: string;                  // Actual code to apply, if determinable
}

/**
 * A concrete fix suggestion that can be applied
 */
export interface FixSuggestion {
  documentUri: string;                 // Serialized URI of document
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  originalCode: string;                // Code being replaced
  fixedCode: string;                   // Replacement code
  explanation: string;                 // Why this fix works
}

/**
 * Messages sent from extension to webview
 */
export type ErrorExplainExtensionMessage =
  | { type: 'loadError'; errorContext: ErrorContext; code: string }
  | { type: 'explanationResult'; requestId: string; explanation: ErrorExplanation }
  | { type: 'explanationError'; requestId: string; error: string }
  | { type: 'fixReady'; fixSuggestion: FixSuggestion }
  | { type: 'applyFixResult'; success: boolean; error?: string };

/**
 * Messages sent from webview to extension
 */
export type ErrorExplainWebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'requestExplanation'; requestId: string; errorContext: ErrorContext; code: string }
  | { type: 'requestFix'; requestId: string; errorContext: ErrorContext; code: string }
  | { type: 'applyFix'; fixSuggestion: FixSuggestion }
  | { type: 'close' };
