/**
 * Error Explanation Webview - Browser-side UI for Error Diagnostics
 *
 * Implements the webview UI with:
 * - Error context display (severity, message, code)
 * - Explanation sections (Root Cause, Why It Happens, How to Fix)
 * - Fixed code preview
 * - Apply Fix button for one-click fixes
 * - Loading and error states
 */

import type {
  ErrorExplainExtensionMessage,
  ErrorExplainWebviewMessage,
  ErrorContext,
  ErrorExplanation,
  FixSuggestion,
} from '../types/errorExplanation';

// Acquire VS Code API (call once, cache result)
declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

const vscode = acquireVsCodeApi();

// State
let currentErrorContext: ErrorContext | undefined;
let currentCode: string | undefined;
let currentExplanation: ErrorExplanation | undefined;
let currentFixSuggestion: FixSuggestion | undefined;
let isLoading = false;
let errorMessage: string | undefined;

// Initialize DOM after load
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  initializeDOM();
  setupEventListeners();
  updateUI();

  // Signal to extension that webview is ready
  vscode.postMessage({ type: 'webviewReady' } as ErrorExplainWebviewMessage);
});

/**
 * Inject CSS styles into document head
 */
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
body {
  padding: 0;
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

.error-panel {
  padding: 16px;
  max-width: 900px;
  margin: 0 auto;
}

.error-header {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder));
}

.severity-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 10px;
}

.severity-badge.error {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.severity-badge.warning {
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-editorWarning-foreground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
}

.error-message {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 12px;
  color: var(--vscode-editor-foreground);
}

.error-code-preview {
  background: var(--vscode-textCodeBlock-background);
  padding: 10px 12px;
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, transparent);
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-textPreformat-foreground);
  margin-bottom: 20px;
}

.explanation-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--vscode-editor-foreground);
}

.section-content {
  line-height: 1.7;
  color: var(--vscode-editor-foreground);
  white-space: pre-wrap;
}

.fix-preview-section {
  margin-top: 24px;
  padding: 16px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 4px solid var(--vscode-textBlockQuote-border);
  border-radius: 4px;
}

.fix-preview-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--vscode-editor-foreground);
}

.fix-code-block {
  background: var(--vscode-textCodeBlock-background);
  padding: 12px;
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, transparent);
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-textPreformat-foreground);
  margin-bottom: 12px;
}

.apply-fix-btn {
  padding: 8px 16px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 14px;
  font-weight: 500;
  transition: background-color 0.1s ease;
}

.apply-fix-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.apply-fix-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-spinner {
  display: none;
  text-align: center;
  padding: 40px 20px;
  color: var(--vscode-descriptionForeground);
}

.loading-spinner.visible {
  display: block;
}

.spinner-icon {
  display: inline-block;
  width: 24px;
  height: 24px;
  border: 3px solid var(--vscode-progressBar-background);
  border-top-color: var(--vscode-button-background);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  margin-top: 12px;
  font-size: 14px;
}

.error-state {
  display: none;
  color: var(--vscode-errorForeground);
  padding: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  margin: 20px 0;
}

.error-state.visible {
  display: block;
}

.error-state-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.error-state-details {
  opacity: 0.9;
}

.empty-state {
  display: none;
  text-align: center;
  padding: 60px 20px;
  color: var(--vscode-descriptionForeground);
  font-size: 14px;
}

.empty-state.visible {
  display: block;
}
`;
  document.head.appendChild(style);
}

/**
 * Create DOM structure dynamically
 */
function initializeDOM() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="error-panel">
      <div class="error-header" id="error-header" style="display: none;">
        <div class="severity-badge" id="severity-badge">Error</div>
        <div class="error-message" id="error-message"></div>
        <div class="error-code-preview" id="error-code-preview"></div>
      </div>

      <div class="loading-spinner" id="loading-spinner">
        <div class="spinner-icon"></div>
        <div class="loading-text">Analyzing error...</div>
      </div>

      <div class="error-state" id="error-state">
        <div class="error-state-title">Analysis Failed</div>
        <div class="error-state-details" id="error-state-details"></div>
      </div>

      <div id="explanation-content" style="display: none;">
        <div class="explanation-section">
          <div class="section-title">Root Cause</div>
          <div class="section-content" id="root-cause"></div>
        </div>

        <div class="explanation-section">
          <div class="section-title">Why It Happens</div>
          <div class="section-content" id="why-it-happens"></div>
        </div>

        <div class="explanation-section">
          <div class="section-title">How to Fix</div>
          <div class="section-content" id="suggested-fix"></div>
        </div>
      </div>

      <div class="fix-preview-section" id="fix-preview" style="display: none;">
        <div class="fix-preview-title">Suggested Fix</div>
        <div class="fix-code-block" id="fix-code-block"></div>
        <button class="apply-fix-btn" id="apply-fix-btn">Apply Fix</button>
      </div>

      <div class="empty-state" id="empty-state">
        Waiting for error diagnostic...
      </div>
    </div>
  `;
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // Listen for messages from extension
  window.addEventListener('message', handleExtensionMessage);

  // Apply fix button
  const applyFixBtn = document.getElementById('apply-fix-btn');
  applyFixBtn?.addEventListener('click', () => {
    if (currentFixSuggestion) {
      vscode.postMessage({
        type: 'applyFix',
        fixSuggestion: currentFixSuggestion,
      } as ErrorExplainWebviewMessage);

      // Disable button while applying
      if (applyFixBtn instanceof HTMLButtonElement) {
        applyFixBtn.disabled = true;
        applyFixBtn.textContent = 'Applying...';
      }
    }
  });
}

/**
 * Handle messages from extension
 */
function handleExtensionMessage(event: MessageEvent) {
  const message: ErrorExplainExtensionMessage = event.data;

  switch (message.type) {
    case 'loadError':
      // Store error context and code
      currentErrorContext = message.errorContext;
      currentCode = message.code;
      isLoading = true;
      errorMessage = undefined;
      updateUI();
      break;

    case 'explanationResult':
      // Display explanation
      currentExplanation = message.explanation;
      isLoading = false;
      errorMessage = undefined;
      updateUI();
      break;

    case 'fixReady':
      // Display fix suggestion
      currentFixSuggestion = message.fixSuggestion;
      isLoading = false;
      errorMessage = undefined;
      updateUI();
      break;

    case 'explanationError':
      // Show error
      errorMessage = message.error;
      isLoading = false;
      updateUI();
      break;

    case 'applyFixResult': {
      // Re-enable apply button
      const applyFixBtn = document.getElementById('apply-fix-btn');
      if (applyFixBtn instanceof HTMLButtonElement) {
        applyFixBtn.disabled = false;
        applyFixBtn.textContent = message.success ? 'Applied ✓' : 'Apply Fix';
      }
      break;
    }
  }
}

/**
 * Update UI to reflect current state
 */
function updateUI() {
  const errorHeader = document.getElementById('error-header');
  const loadingSpinner = document.getElementById('loading-spinner');
  const errorState = document.getElementById('error-state');
  const explanationContent = document.getElementById('explanation-content');
  const fixPreview = document.getElementById('fix-preview');
  const emptyState = document.getElementById('empty-state');

  // Hide everything first
  errorHeader?.style.setProperty('display', 'none');
  loadingSpinner?.classList.remove('visible');
  errorState?.classList.remove('visible');
  explanationContent?.style.setProperty('display', 'none');
  fixPreview?.style.setProperty('display', 'none');
  emptyState?.classList.remove('visible');

  // Show error header if we have error context
  if (currentErrorContext && currentCode) {
    errorHeader?.style.setProperty('display', 'block');
    renderErrorHeader(currentErrorContext, currentCode);
  }

  // Show appropriate content based on state
  if (isLoading) {
    loadingSpinner?.classList.add('visible');
  } else if (errorMessage) {
    errorState?.classList.add('visible');
    const errorDetails = document.getElementById('error-state-details');
    if (errorDetails) {
      errorDetails.textContent = errorMessage;
    }
  } else if (currentExplanation) {
    explanationContent?.style.setProperty('display', 'block');
    renderExplanation(currentExplanation);
  } else if (currentFixSuggestion) {
    fixPreview?.style.setProperty('display', 'block');
    renderFixPreview(currentFixSuggestion);
  } else if (!currentErrorContext) {
    // Empty state - no error loaded yet
    emptyState?.classList.add('visible');
  }
}

/**
 * Render error header
 */
function renderErrorHeader(errorContext: ErrorContext, code: string) {
  const severityBadge = document.getElementById('severity-badge');
  const errorMessage = document.getElementById('error-message');
  const errorCodePreview = document.getElementById('error-code-preview');

  if (severityBadge) {
    severityBadge.textContent = errorContext.severity === 'error' ? 'Error' : 'Warning';
    severityBadge.className = `severity-badge ${errorContext.severity}`;
  }

  if (errorMessage) {
    errorMessage.textContent = errorContext.errorMessage;
  }

  if (errorCodePreview) {
    errorCodePreview.textContent = code;
  }
}

/**
 * Render explanation sections
 */
function renderExplanation(explanation: ErrorExplanation) {
  const rootCause = document.getElementById('root-cause');
  const whyItHappens = document.getElementById('why-it-happens');
  const suggestedFix = document.getElementById('suggested-fix');

  if (rootCause) {
    rootCause.textContent = explanation.rootCause;
  }

  if (whyItHappens) {
    whyItHappens.textContent = explanation.whyItHappens;
  }

  if (suggestedFix) {
    suggestedFix.textContent = explanation.suggestedFix;
  }
}

/**
 * Render fix preview with Apply Fix button
 */
function renderFixPreview(fixSuggestion: FixSuggestion) {
  const fixCodeBlock = document.getElementById('fix-code-block');
  const applyFixBtn = document.getElementById('apply-fix-btn');

  if (fixCodeBlock) {
    fixCodeBlock.textContent = fixSuggestion.fixedCode;
  }

  if (applyFixBtn instanceof HTMLButtonElement) {
    applyFixBtn.disabled = false;
    applyFixBtn.textContent = 'Apply Fix';
  }
}
