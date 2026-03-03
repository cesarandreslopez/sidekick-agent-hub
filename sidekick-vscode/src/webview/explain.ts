/**
 * Explain Code Webview - Browser-side UI for Code Explanations
 *
 * Implements the webview UI with:
 * - Complexity level selector bar
 * - Markdown rendering with sanitization (marked + DOMPurify)
 * - Loading and error states
 * - Message passing with extension
 * - State persistence via vscode.setState()
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ExplainExtensionMessage, ExplainWebviewMessage, ExplainState, FileContext } from '../types/explain';
import type { ComplexityLevel } from '../types/explain';
import { COMPLEXITY_LABELS } from '../types/explain';
import { DEFAULT_EXPLAIN_STATE } from '../types/explain';

// Acquire VS Code API (call once, cache result)
declare function acquireVsCodeApi(): {
  getState: () => ExplainState | undefined;
  setState: (state: ExplainState) => void;
  postMessage: (message: unknown) => void;
};

const vscode = acquireVsCodeApi();

// Restore state from previous session
const state: ExplainState = vscode.getState() || { ...DEFAULT_EXPLAIN_STATE };

// Current request ID for tracking async operations
let currentRequestId: string | undefined;

// Initialize DOM after load
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  initializeDOM();
  setupEventListeners();
  updateUI();

  // Signal to extension that webview is ready
  vscode.postMessage({ type: 'webviewReady' } as ExplainWebviewMessage);
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

.explain-panel {
  padding: 16px;
  max-width: 900px;
  margin: 0 auto;
}

.complexity-bar {
  display: flex;
  gap: 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
  background: var(--vscode-input-background);
}

.complexity-btn {
  padding: 7px 14px;
  border: none;
  border-right: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder));
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  font-family: var(--vscode-font-family);
  transition: background 0.15s ease, color 0.15s ease;
  flex: 1;
  text-align: center;
  white-space: nowrap;
}

.complexity-btn:last-child {
  border-right: none;
}

.complexity-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.complexity-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder));
}

.toolbar-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 8px;
}

#explanation-content {
  line-height: 1.7;
  color: var(--vscode-editor-foreground);
}

#explanation-content p {
  margin: 0 0 16px 0;
}

#explanation-content p:last-child {
  margin-bottom: 0;
}

#explanation-content code {
  background: var(--vscode-textCodeBlock-background);
  color: var(--vscode-textPreformat-foreground);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
}

#explanation-content pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 16px 0;
  border: 1px solid var(--vscode-panel-border, transparent);
}

#explanation-content pre code {
  background: none;
  padding: 0;
}

#explanation-content h1,
#explanation-content h2,
#explanation-content h3,
#explanation-content h4 {
  color: var(--vscode-editor-foreground);
  margin: 20px 0 12px 0;
  font-weight: 600;
}

#explanation-content h1 { font-size: 1.5em; }
#explanation-content h2 { font-size: 1.3em; }
#explanation-content h3 { font-size: 1.1em; }
#explanation-content h4 { font-size: 1em; }

#explanation-content ul,
#explanation-content ol {
  margin: 12px 0;
  padding-left: 24px;
}

#explanation-content li {
  margin: 6px 0;
}

#explanation-content blockquote {
  margin: 16px 0;
  padding: 8px 16px;
  border-left: 4px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-textPreformat-foreground);
}

#explanation-content strong {
  font-weight: 600;
  color: var(--vscode-editor-foreground);
}

#explanation-content em {
  font-style: italic;
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

.spinner-dots span:nth-child(2) {
  animation-delay: 0.15s;
}

.spinner-dots span:nth-child(3) {
  animation-delay: 0.3s;
}

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

.error-message {
  display: none;
  color: var(--vscode-errorForeground);
  padding: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 6px;
  margin: 20px 0;
  border-left: 3px solid var(--vscode-editorError-foreground, #f44336);
}

.error-message.visible {
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: fadeIn 0.2s ease-out;
}

.error-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.error-details {
  opacity: 0.9;
  line-height: 1.5;
  font-size: 13px;
}

.retry-btn {
  align-self: flex-start;
  padding: 6px 14px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 12px;
  font-weight: 500;
  transition: background 0.15s ease;
}

.retry-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

#explanation-content {
  animation: contentReveal 0.3s ease-out;
}

@keyframes contentReveal {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
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
  gap: 12px;
  animation: fadeIn 0.3s ease-out;
}

.empty-state-icon {
  font-size: 32px;
  opacity: 0.4;
  line-height: 1;
}

.empty-state-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--vscode-foreground);
  opacity: 0.7;
}

.empty-state-hint {
  font-size: 12px;
  max-width: 280px;
  line-height: 1.5;
  opacity: 0.8;
}

.empty-state kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: 3px;
  color: var(--vscode-textPreformat-foreground);
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
    <div class="explain-panel">
      <div class="toolbar">
        <div class="complexity-bar" id="complexity-bar"></div>
      </div>
      <div class="loading-spinner" id="loading-spinner">
        <div class="spinner-dots"><span></span><span></span><span></span></div>
        <div class="loading-text">Generating explanation...</div>
      </div>
      <div class="error-message" id="error-message">
        <div class="error-title">Explanation Failed</div>
        <div class="error-details" id="error-details"></div>
        <button class="retry-btn" id="retry-btn">Try Again</button>
      </div>
      <div id="explanation-content"></div>
      <div class="empty-state" id="empty-state">
        <div class="empty-state-icon">&lt;/&gt;</div>
        <div class="empty-state-title">Explain Selection</div>
        <div class="empty-state-hint">Select code in the editor, then use <kbd>Explain Selection</kbd> from the command palette or context menu.</div>
      </div>
    </div>
  `;

  // Render complexity buttons
  renderComplexityBar();
}

/**
 * Render complexity selector buttons
 */
function renderComplexityBar() {
  const complexityBar = document.getElementById('complexity-bar');
  if (!complexityBar) return;

  // Create button for each complexity level
  const levels: ComplexityLevel[] = ['eli5', 'curious-amateur', 'imposter-syndrome', 'senior', 'phd'];

  complexityBar.innerHTML = levels
    .map(level => {
      const isActive = level === state.complexity;
      const label = COMPLEXITY_LABELS[level];
      return `<button class="complexity-btn ${isActive ? 'active' : ''}" data-complexity="${level}">${label}</button>`;
    })
    .join('');
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // Listen for messages from extension
  window.addEventListener('message', handleExtensionMessage);

  // Complexity button clicks (using event delegation)
  const complexityBar = document.getElementById('complexity-bar');
  complexityBar?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('complexity-btn')) {
      const complexity = target.dataset.complexity as ComplexityLevel;
      if (complexity) {
        changeComplexity(complexity);
      }
    }
  });

  // Retry button
  const retryBtn = document.getElementById('retry-btn');
  retryBtn?.addEventListener('click', () => {
    if (state.code) {
      requestExplanation(state.code, state.complexity, state.fileContext);
    }
  });

}

/**
 * Handle messages from extension
 */
function handleExtensionMessage(event: MessageEvent) {
  const message: ExplainExtensionMessage = event.data;

  switch (message.type) {
    case 'loadCode':
      // Store code and file context, then request explanation
      state.code = message.code;
      state.fileContext = message.fileContext;
      state.isLoading = true;
      state.error = undefined;
      saveState();
      updateUI();
      requestExplanation(message.code, state.complexity, message.fileContext);
      break;

    case 'explanationResult':
      // Check if this is the current request
      if (message.requestId === currentRequestId) {
        state.currentExplanation = message.explanation;
        state.isLoading = false;
        state.error = undefined;
        currentRequestId = undefined;
        saveState();
        updateUI();
      }
      break;

    case 'explanationError':
      // Check if this is the current request
      if (message.requestId === currentRequestId) {
        state.error = message.error;
        state.isLoading = false;
        currentRequestId = undefined;
        saveState();
        updateUI();
      }
      break;

    case 'complexityChanged':
      state.complexity = message.complexity;
      saveState();
      renderComplexityBar();
      break;
  }
}

/**
 * Request explanation from extension
 */
function requestExplanation(code: string, complexity: ComplexityLevel, fileContext?: FileContext) {
  currentRequestId = generateRequestId();

  state.isLoading = true;
  state.error = undefined;
  saveState();
  updateUI();

  vscode.postMessage({
    type: 'requestExplanation',
    requestId: currentRequestId,
    code,
    complexity,
    fileContext
  } as ExplainWebviewMessage);
}

/**
 * Change complexity level and request new explanation
 */
function changeComplexity(complexity: ComplexityLevel) {
  if (complexity === state.complexity) return;

  state.complexity = complexity;
  saveState();
  renderComplexityBar();

  // If we have code, request new explanation
  if (state.code) {
    requestExplanation(state.code, complexity, state.fileContext);
  }

  // Also notify extension of complexity change
  vscode.postMessage({
    type: 'changeComplexity',
    complexity
  } as ExplainWebviewMessage);
}

/**
 * Render explanation as markdown
 */
function renderExplanation(markdown: string) {
  const contentEl = document.getElementById('explanation-content');
  if (!contentEl) return;

  // Parse markdown
  const rawHtml = marked.parse(markdown) as string;

  // Sanitize HTML
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'span'],
    ALLOWED_ATTR: ['class']
  });

  contentEl.innerHTML = cleanHtml;
}

/**
 * Show loading spinner
 */
function showLoading() {
  const spinner = document.getElementById('loading-spinner');
  if (spinner) {
    spinner.classList.add('visible');
  }
}

/**
 * Hide loading spinner
 */
function hideLoading() {
  const spinner = document.getElementById('loading-spinner');
  if (spinner) {
    spinner.classList.remove('visible');
  }
}

/**
 * Show error message
 */
function showError(message: string) {
  const errorEl = document.getElementById('error-message');
  const errorDetails = document.getElementById('error-details');

  if (errorEl && errorDetails) {
    errorDetails.textContent = message;
    errorEl.classList.add('visible');
  }
}

/**
 * Hide error message
 */
function hideError() {
  const errorEl = document.getElementById('error-message');
  if (errorEl) {
    errorEl.classList.remove('visible');
  }
}

/**
 * Update UI to reflect current state
 */
function updateUI() {
  const contentEl = document.getElementById('explanation-content');
  const emptyState = document.getElementById('empty-state');

  // Hide everything first
  hideLoading();
  hideError();
  if (contentEl) contentEl.innerHTML = '';
  if (emptyState) emptyState.classList.remove('visible');

  // Show appropriate content based on state
  if (state.isLoading) {
    showLoading();
  } else if (state.error) {
    showError(state.error);
  } else if (state.currentExplanation) {
    renderExplanation(state.currentExplanation);
  } else {
    // Empty state - no code loaded yet
    if (emptyState) emptyState.classList.add('visible');
  }
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Save state to VS Code
 */
function saveState() {
  vscode.setState(state);
}
