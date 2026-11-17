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
/** The newest request; replies for any other id are dropped. */
let currentRequestId: string | undefined;
let currentMode: 'explain' | 'fix' | undefined;
/**
 * The panel only opens for a request, so it starts in the loading state until
 * the host's `loadError` arrives (instead of flashing "Ready to diagnose").
 */
let awaitingFirstRequest = true;
let cancelled = false;
let fixApplied = false;
let applyFixError: string | undefined;

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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.severity-badge::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
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
  padding: 14px;
  background: var(--vscode-textBlockQuote-background, transparent);
  border-radius: 6px;
  border-left: 3px solid var(--vscode-panel-border);
  animation: sectionReveal 0.3s ease-out both;
}

.explanation-section:nth-child(1) { animation-delay: 0s; }
.explanation-section:nth-child(2) { animation-delay: 0.08s; }
.explanation-section:nth-child(3) { animation-delay: 0.16s; }

@keyframes sectionReveal {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}

.explanation-section:nth-child(1) { border-left-color: var(--vscode-editorError-foreground, #f44336); }
.explanation-section:nth-child(2) { border-left-color: var(--vscode-editorWarning-foreground, #ff9800); }
.explanation-section:nth-child(3) { border-left-color: var(--vscode-testing-iconPassed, #4caf50); }

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--vscode-editor-foreground);
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-title::before {
  font-size: 14px;
  line-height: 1;
}

.explanation-section:nth-child(1) .section-title::before { content: '\u26A0'; }
.explanation-section:nth-child(2) .section-title::before { content: '\u2139'; }
.explanation-section:nth-child(3) .section-title::before { content: '\u2705'; }

.section-content {
  line-height: 1.7;
  color: var(--vscode-editor-foreground);
  white-space: pre-wrap;
  font-size: 13px;
}

.fix-preview-section {
  margin-top: 24px;
  padding: 16px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 4px solid var(--vscode-testing-iconPassed, #4caf50);
  border-radius: 6px;
  animation: sectionReveal 0.3s ease-out both;
}

.fix-preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--vscode-editor-foreground);
  display: flex;
  align-items: center;
  gap: 6px;
}

.fix-preview-title::before {
  content: '\u2728';
  font-size: 14px;
}

.fix-code-block {
  background: var(--vscode-textCodeBlock-background);
  padding: 14px;
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border, transparent);
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-textPreformat-foreground);
  margin-bottom: 14px;
  line-height: 1.5;
}

.apply-fix-btn {
  padding: 8px 20px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s ease, transform 0.1s ease;
}

.apply-fix-btn:hover {
  background: var(--vscode-button-hoverBackground);
  transform: translateY(-1px);
}

.apply-fix-btn:active {
  transform: translateY(0);
}

.apply-fix-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.apply-fix-btn:focus-visible {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

.apply-fix-btn.applied {
  background: var(--vscode-testing-iconPassed, #4caf50);
  border-color: var(--vscode-testing-iconPassed, #4caf50);
}

.apply-fix-btn.applying {
  position: relative;
  color: transparent;
}

.apply-fix-btn.applying::after {
  content: 'Applying...';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-button-foreground);
  animation: applyPulse 1.2s ease-in-out infinite;
}

@keyframes applyPulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.loading-spinner {
  display: none;
  text-align: center;
  padding: 48px 20px;
  color: var(--vscode-descriptionForeground);
}

.loading-spinner.visible {
  display: flex;
  flex-direction: column;
  align-items: center;
  animation: fadeIn 0.2s ease-out;
}

.spinner-dots {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}

.spinner-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-textLink-foreground);
  animation: dotPulse 1.2s ease-in-out infinite;
}

.spinner-dots span:nth-child(2) { animation-delay: 0.15s; }
.spinner-dots span:nth-child(3) { animation-delay: 0.3s; }

@keyframes dotPulse {
  0%, 60%, 100% { opacity: 0.2; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.loading-text {
  font-size: 13px;
  font-weight: 500;
}

.error-state {
  display: none;
  color: var(--vscode-errorForeground);
  padding: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 6px;
  border-left: 3px solid var(--vscode-editorError-foreground, #f44336);
  margin: 20px 0;
}

.error-state.visible {
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: fadeIn 0.2s ease-out;
}

.error-state-title {
  font-weight: 600;
}

.error-state-details {
  opacity: 0.9;
  line-height: 1.5;
  font-size: 13px;
}

.retry-btn {
  align-self: flex-start;
  margin-top: 4px;
  padding: 4px 12px;
  border: none;
  border-radius: 3px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-family: var(--vscode-font-family);
  font-size: 12px;
  cursor: pointer;
}

.retry-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.retry-btn:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

.cancel-request-btn {
  margin-top: 16px;
  align-self: center;
}

.cancelled-state {
  display: none;
  color: var(--vscode-descriptionForeground);
  padding: 16px;
  margin: 20px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.cancelled-state.visible {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.apply-fix-error {
  display: none;
  margin-top: 8px;
  color: var(--vscode-errorForeground);
  font-size: 12px;
}

.apply-fix-error.visible {
  display: block;
}

.empty-state {
  display: none;
  text-align: center;
  padding: 60px 24px;
  color: var(--vscode-descriptionForeground);
}

.empty-state.visible {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  animation: fadeIn 0.3s ease-out;
}

.empty-state-icon {
  font-size: 32px;
  opacity: 0.4;
  line-height: 1;
}

.empty-state-text {
  font-size: 13px;
  max-width: 280px;
  line-height: 1.5;
}

.empty-state-hint {
  font-size: 12px;
  max-width: 280px;
  line-height: 1.5;
  opacity: 0.7;
  margin-top: 4px;
}

.sk-hidden {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* VS Code's workbench.reduceMotion setting puts this class on the body. */
body.vscode-reduce-motion *,
body.vscode-reduce-motion *::before,
body.vscode-reduce-motion *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
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
    <main class="error-panel">
      <div class="error-header sk-hidden" id="error-header">
        <div class="severity-badge" id="severity-badge">Error</div>
        <div class="error-message" id="error-message"></div>
        <div class="error-code-preview" id="error-code-preview"></div>
      </div>

      <div class="loading-spinner" id="loading-spinner" role="status" aria-label="Analyzing error">
        <div class="spinner-dots"><span></span><span></span><span></span></div>
        <div class="loading-text" id="loading-text">Analyzing error...</div>
        <button type="button" class="retry-btn cancel-request-btn" id="cancel-btn">Cancel</button>
      </div>

      <div class="error-state" id="error-state" role="alert">
        <div class="error-state-title" id="error-state-title">Analysis Failed</div>
        <div class="error-state-details" id="error-state-details"></div>
        <button type="button" class="retry-btn" id="retry-btn">Try Again</button>
      </div>

      <div class="cancelled-state" id="cancelled-state" role="status">
        <div class="cancelled-state-text">Cancelled.</div>
        <button type="button" class="retry-btn" id="retry-cancelled-btn">Run Again</button>
      </div>

      <div id="explanation-content" class="sk-hidden" role="region" aria-label="Error explanation">
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

      <div class="fix-preview-section sk-hidden" id="fix-preview">
        <div class="fix-preview-title">Suggested Fix</div>
        <div class="fix-code-block" id="fix-code-block"></div>
        <button class="apply-fix-btn" id="apply-fix-btn" aria-label="Apply suggested fix">Apply Fix</button>
        <div class="apply-fix-error" id="apply-fix-error" role="alert"></div>
      </div>

      <div class="empty-state" id="empty-state">
        <div class="empty-state-icon">\u26A0</div>
        <div class="empty-state-text">Ready to diagnose</div>
        <div class="empty-state-hint">Put the cursor on an error or warning, then press <kbd>Ctrl+.</kbd> (<kbd>Cmd+.</kbd> on macOS) and choose "Explain Error with AI" or "Fix Error with AI", or right-click and choose <kbd>Sidekick › Explain Error with AI</kbd>.</div>
      </div>
    </main>
  `;
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // Listen for messages from extension
  window.addEventListener('message', handleExtensionMessage);

  const retry = () => {
    vscode.postMessage({ type: 'retry' } as ErrorExplainWebviewMessage);
  };
  document.getElementById('retry-btn')?.addEventListener('click', retry);
  document.getElementById('retry-cancelled-btn')?.addEventListener('click', retry);
  document.getElementById('cancel-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' } as ErrorExplainWebviewMessage);
  });

  // Apply fix button: the host holds the fix and checks the document version.
  const applyFixBtn = document.getElementById('apply-fix-btn');
  applyFixBtn?.addEventListener('click', () => {
    if (currentFixSuggestion) {
      applyFixError = undefined;
      renderApplyFixError();
      vscode.postMessage({ type: 'applyFix' } as ErrorExplainWebviewMessage);

      // Show applying state with animation
      if (applyFixBtn instanceof HTMLButtonElement) {
        applyFixBtn.disabled = true;
        applyFixBtn.classList.add('applying');
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

  // Results from a superseded request never reach the screen.
  if (
    'requestId' in message &&
    message.type !== 'loadError' &&
    message.requestId !== currentRequestId
  ) {
    return;
  }

  switch (message.type) {
    case 'loadError':
      // A new request replaces everything the panel was showing.
      awaitingFirstRequest = false;
      currentRequestId = message.requestId;
      currentMode = message.mode;
      currentErrorContext = message.errorContext;
      currentCode = message.code;
      currentExplanation = undefined;
      currentFixSuggestion = undefined;
      fixApplied = false;
      applyFixError = undefined;
      cancelled = false;
      isLoading = true;
      errorMessage = undefined;
      updateUI();
      break;

    case 'explanationResult':
      if (currentMode !== 'explain') break;
      currentExplanation = message.explanation;
      isLoading = false;
      errorMessage = undefined;
      updateUI();
      break;

    case 'fixReady':
      if (currentMode !== 'fix') break;
      currentFixSuggestion = message.fixSuggestion;
      isLoading = false;
      errorMessage = undefined;
      updateUI();
      break;

    case 'explanationError':
      errorMessage = message.error;
      isLoading = false;
      updateUI();
      break;

    case 'cancelled':
      cancelled = true;
      isLoading = false;
      errorMessage = undefined;
      updateUI();
      break;

    case 'applyFixResult': {
      const applyFixBtn = document.getElementById('apply-fix-btn');
      if (applyFixBtn instanceof HTMLButtonElement) {
        applyFixBtn.classList.remove('applying');
        if (message.success) {
          // Applied once: the button stays disabled so the range isn't replaced twice.
          fixApplied = true;
          applyFixBtn.disabled = true;
          applyFixBtn.textContent = 'Applied';
          applyFixBtn.classList.add('applied');
        } else {
          applyFixBtn.disabled = false;
          applyFixBtn.textContent = 'Apply Fix';
          applyFixBtn.classList.remove('applied');
        }
      }
      applyFixError = message.success
        ? undefined
        : (message.error ?? 'The fix could not be applied.');
      renderApplyFixError();
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
  const cancelledState = document.getElementById('cancelled-state');

  // Hide everything first
  errorHeader?.classList.add('sk-hidden');
  loadingSpinner?.classList.remove('visible');
  errorState?.classList.remove('visible');
  explanationContent?.classList.add('sk-hidden');
  fixPreview?.classList.add('sk-hidden');
  emptyState?.classList.remove('visible');
  cancelledState?.classList.remove('visible');

  // Show error header if we have error context
  if (currentErrorContext && currentCode) {
    errorHeader?.classList.remove('sk-hidden');
    renderErrorHeader(currentErrorContext, currentCode);
  }

  // Fix mode generates a fix; say so instead of "Analyzing".
  const fixMode = currentMode === 'fix';
  const loadingLabel = fixMode ? 'Generating fix...' : 'Analyzing error...';
  const loadingText = document.getElementById('loading-text');
  if (loadingText) loadingText.textContent = loadingLabel;
  loadingSpinner?.setAttribute('aria-label', loadingLabel);
  const errorTitle = document.getElementById('error-state-title');
  if (errorTitle) errorTitle.textContent = fixMode ? "Couldn't generate a fix" : 'Analysis Failed';

  // Show appropriate content based on state
  if (isLoading || awaitingFirstRequest) {
    loadingSpinner?.classList.add('visible');
  } else if (cancelled) {
    cancelledState?.classList.add('visible');
  } else if (errorMessage) {
    errorState?.classList.add('visible');
    const errorDetails = document.getElementById('error-state-details');
    if (errorDetails) {
      errorDetails.textContent = errorMessage;
    }
  } else if (currentExplanation) {
    explanationContent?.classList.remove('sk-hidden');
    renderExplanation(currentExplanation);
  } else if (currentFixSuggestion) {
    fixPreview?.classList.remove('sk-hidden');
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
    applyFixBtn.disabled = fixApplied;
    applyFixBtn.textContent = fixApplied ? 'Applied' : 'Apply Fix';
    applyFixBtn.classList.toggle('applied', fixApplied);
  }
  renderApplyFixError();
}

/**
 * Show (or clear) the reason the last Apply Fix failed.
 */
function renderApplyFixError() {
  const el = document.getElementById('apply-fix-error');
  if (!el) return;
  el.textContent = applyFixError ?? '';
  el.classList.toggle('visible', Boolean(applyFixError));
}
