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
  gap: 8px;
  flex-wrap: wrap;
}

.complexity-btn {
  padding: 6px 14px;
  border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
  font-family: var(--vscode-font-family);
  transition: background-color 0.1s ease;
}

.complexity-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.complexity-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder));
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

.error-message {
  display: none;
  color: var(--vscode-errorForeground);
  padding: 16px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  margin: 20px 0;
}

.error-message.visible {
  display: block;
}

.error-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.error-details {
  margin-bottom: 12px;
  opacity: 0.9;
}

.retry-btn {
  padding: 6px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 13px;
}

.retry-btn:hover {
  background: var(--vscode-button-hoverBackground);
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
    <div class="explain-panel">
      <div class="toolbar">
        <div class="complexity-bar" id="complexity-bar"></div>
      </div>
      <div class="loading-spinner" id="loading-spinner">
        <div class="spinner-icon"></div>
        <div class="loading-text">Generating explanation...</div>
      </div>
      <div class="error-message" id="error-message">
        <div class="error-title">Explanation Failed</div>
        <div class="error-details" id="error-details"></div>
        <button class="retry-btn" id="retry-btn">Try Again</button>
      </div>
      <div id="explanation-content"></div>
      <div class="empty-state" id="empty-state">
        Select code and use "Explain Selection" to begin
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
