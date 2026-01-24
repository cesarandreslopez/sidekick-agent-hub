/**
 * RSVP Speed Reader - Type Definitions
 *
 * Shared types between extension and webview for RSVP functionality.
 * Phase 1: Core RSVP types
 * Phase 2: AI-related types for classification and explanation
 */

/**
 * Phase 2: Content Type Classification
 * Determines the nature of content for adaptive explanation
 */
export type ContentType = 'prose' | 'technical' | 'code';

/**
 * Phase 2: Complexity Level Enum
 * Controls explanation depth and technical detail
 */
export type ComplexityLevel = 'eli5' | 'curious-amateur' | 'imposter-syndrome' | 'senior' | 'phd';

/**
 * Phase 2: Display labels for complexity levels
 */
export const COMPLEXITY_LABELS: Record<ComplexityLevel, string> = {
  'eli5': 'ELI5',
  'curious-amateur': 'Curious Amateur',
  'imposter-syndrome': 'Imposter Syndrome',
  'senior': 'Senior',
  'phd': 'PhD Mode'
};

/**
 * Webview state for RSVP reader.
 * Persisted via vscode.setState() to survive hide/show cycles.
 */
export interface RsvpState {
  words: string[];           // Tokenized words from input text
  currentIndex: number;      // Current word position (0-based)
  wpm: number;              // Words per minute (100-900)
  isPlaying: boolean;       // Playback state
  // Phase 2 AI fields
  mode: 'direct' | 'explain-first';
  complexity: ComplexityLevel;
  contentType?: ContentType;
  currentExplanation?: string;
  isClassifying?: boolean;
  isExplaining?: boolean;
}

/**
 * Messages sent from extension to webview
 */
export type ExtensionMessage =
  | { type: 'loadText'; text: string; original?: string }
  | { type: 'classificationResult'; requestId: string; contentType: ContentType }
  | { type: 'explanationResult'; requestId: string; explanation: string }
  | { type: 'explanationError'; requestId: string; error: string }
  | { type: 'regenerating' }
  | { type: 'regenerateResult'; explanation: string }
  | { type: 'regenerateError'; error: string };

/**
 * Messages sent from webview to extension
 */
export type WebviewMessage =
  | { type: 'stateUpdate'; state: RsvpState }
  | { type: 'requestClassification'; requestId: string; text: string }
  | { type: 'requestExplanation'; requestId: string; text: string; contentType: ContentType; complexity: ComplexityLevel }
  | { type: 'cancelPendingRequests' }
  | { type: 'webviewReady' }
  | { type: 'requestRegenerate'; instructions: string };

/**
 * Default initial state for RSVP reader
 */
export const DEFAULT_RSVP_STATE: RsvpState = {
  words: [],
  currentIndex: 0,
  wpm: 300,
  isPlaying: false,
  mode: 'direct',
  complexity: 'imposter-syndrome',
};
