/**
 * RSVP Speed Reader - Webview Entry Point
 *
 * Implements the core RSVP engine with:
 * - ORP (Optimal Recognition Point) calculation at ~1/3 word position
 * - WPM-based timing with punctuation pauses
 * - State persistence via vscode.setState() (survives hide/show)
 * - Toggle between RSVP and full-text reading modes
 * - Toggle between explanation and original content
 */

import type { RsvpState, ExtensionMessage, WebviewMessage } from '../types/rsvp';
import { DEFAULT_RSVP_STATE } from '../types/rsvp';

// Acquire VS Code API (call once, cache result)
declare function acquireVsCodeApi(): {
  getState: () => RsvpState | undefined;
  setState: (state: RsvpState) => void;
  postMessage: (message: unknown) => void;
};

const vscode = acquireVsCodeApi();

// Restore state from previous session
let state: RsvpState = vscode.getState() || { ...DEFAULT_RSVP_STATE };

// Content storage
let currentText: string = '';
let originalText: string | undefined;
let isShowingOriginal: boolean = false;
let isRsvpMode: boolean = true;
let iconUri: string = '';
let isRegenerating: boolean = false;

// Timing control
let timerId: number | undefined;
let saveTimeout: number | undefined;

// Initialize DOM after load
document.addEventListener('DOMContentLoaded', () => {
  // Get icon URI from data attribute
  const app = document.getElementById('app');
  iconUri = app?.dataset.icon || '';

  initializeDOM();
  setupEventListeners();
  updateUI();

  // Signal to extension that webview is ready
  vscode.postMessage({ type: 'webviewReady' } as WebviewMessage);
});

/**
 * Create DOM structure dynamically
 */
function initializeDOM() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="rsvp-container">
      <div id="regenerate-section" class="regenerate-section" style="display: none;">
        <input id="regenerate-input" type="text" class="regenerate-input" placeholder="How should the explanation be different?" />
        <button id="regenerate-btn" class="regenerate-btn" title="Regenerate explanation">↻</button>
        <span id="regenerate-status" class="regenerate-status"></span>
      </div>
      <div class="focus-container">
        <div class="focus-line"></div>
        <div id="word-display" class="rsvp-display"></div>
        <div class="focus-line"></div>
      </div>
      <div id="full-text-display" class="full-text-display" style="display: none;"></div>
      <div class="controls-section">
        <div class="wpm-display"><span id="speed-display">${state.wpm}</span> WPM</div>
        <div class="controls">
          <button id="play-btn" class="control-button play-btn">▶ Play</button>
          <button id="stop-btn" class="control-button stop-btn">◼ Stop</button>
          <button id="restart-btn" class="control-button restart-btn">↺ Restart</button>
        </div>
        <div class="speed-control">
          <button id="speed-down" class="speed-btn" title="Decrease speed">−</button>
          <button id="speed-up" class="speed-btn" title="Increase speed">+</button>
        </div>
        <span id="progress" class="progress-indicator">0 / 0</span>
        <div class="view-toggles">
          <button id="toggle-content-btn" class="toggle-btn" style="display: none;" title="Click to toggle">
            <span class="toggle-label">Explanation</span>
          </button>
          <button id="toggle-mode-btn" class="toggle-btn" style="display: none;" title="Click to toggle">
            <span class="toggle-label">RSVP</span>
          </button>
        </div>
        <div id="char-counts" class="char-counts" style="display: none;"></div>
        <div class="shortcuts-hint">
          <span class="shortcut"><kbd>Space</kbd> Play/Pause</span>
          <span class="shortcut"><kbd>←→</kbd> Prev/Next</span>
          <span class="shortcut"><kbd>↑↓</kbd> Speed</span>
          <span class="shortcut"><kbd>R</kbd> Restart</span>
          <span class="shortcut"><kbd>O</kbd> Original</span>
          <span class="shortcut"><kbd>F</kbd> Full Text</span>
        </div>
      </div>
      <div id="empty-state" class="empty-state">
        Select text and use "Speed Read" to begin
      </div>
      <button id="playing-stop-btn" class="playing-stop-btn" title="Stop">◼</button>
    </div>
  `;
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // Listen for messages from extension
  window.addEventListener('message', handleExtensionMessage);

  // Play/pause button
  const playBtn = document.getElementById('play-btn');
  playBtn?.addEventListener('click', togglePlayPause);

  // Stop button
  const stopBtn = document.getElementById('stop-btn');
  stopBtn?.addEventListener('click', stop);

  // Restart button
  const restartBtn = document.getElementById('restart-btn');
  restartBtn?.addEventListener('click', restart);

  // Speed buttons
  const speedDown = document.getElementById('speed-down');
  const speedUp = document.getElementById('speed-up');
  speedDown?.addEventListener('click', () => adjustSpeed(-50));
  speedUp?.addEventListener('click', () => adjustSpeed(50));

  // Toggle buttons
  const toggleContentBtn = document.getElementById('toggle-content-btn');
  const toggleModeBtn = document.getElementById('toggle-mode-btn');
  toggleContentBtn?.addEventListener('click', toggleContent);
  toggleModeBtn?.addEventListener('click', toggleReadingMode);

  // Regenerate controls
  const regenerateBtn = document.getElementById('regenerate-btn');
  const regenerateInput = document.getElementById('regenerate-input') as HTMLInputElement;
  regenerateBtn?.addEventListener('click', () => requestRegenerate());
  regenerateInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      requestRegenerate();
    }
  });

  // Playing stop button (minimal button shown during playback)
  const playingStopBtn = document.getElementById('playing-stop-btn');
  playingStopBtn?.addEventListener('click', stop);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);
}

/**
 * Handle messages from extension
 */
function handleExtensionMessage(event: MessageEvent) {
  const message: ExtensionMessage = event.data;

  switch (message.type) {
    case 'loadText':
      loadText(message.text, message.original);
      break;
    case 'regenerating':
      isRegenerating = true;
      updateUI();
      break;
    case 'regenerateResult':
      isRegenerating = false;
      // Update the explanation with new content
      currentText = message.explanation;
      isShowingOriginal = false;
      state.words = message.explanation.split(/\s+/).filter(w => w.length > 0);
      state.currentIndex = 0;
      state.isPlaying = false;
      saveState();
      // Clear the input
      const input = document.getElementById('regenerate-input') as HTMLInputElement;
      if (input) input.value = '';
      updateUI();
      break;
    case 'regenerateError':
      isRegenerating = false;
      updateUI();
      // Could show error to user
      console.error('Regeneration error:', message.error);
      break;
  }
}

/**
 * Load new text for speed reading
 * @param text - Text to read (explanation if original provided, otherwise the content)
 * @param original - Original text (if explanation was generated)
 */
function loadText(text: string, original?: string) {
  currentText = text;
  originalText = original;
  isShowingOriginal = false;

  // Parse text into words
  state.words = text.split(/\s+/).filter(w => w.length > 0);
  state.currentIndex = 0;
  state.isPlaying = false;

  saveState();
  updateUI();

  // Hide empty state
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'none';
}

/**
 * Toggle between original and explanation content
 */
function toggleContent() {
  if (!originalText) return;

  isShowingOriginal = !isShowingOriginal;
  const textToShow = isShowingOriginal ? originalText : currentText;

  // Stop playback and reload
  pause();
  state.words = textToShow.split(/\s+/).filter(w => w.length > 0);
  state.currentIndex = 0;
  saveState();
  updateUI();
}

/**
 * Toggle between RSVP and full-text reading mode
 */
function toggleReadingMode() {
  isRsvpMode = !isRsvpMode;
  pause();
  updateUI();
}

/**
 * Request regeneration with extra instructions
 */
function requestRegenerate() {
  if (!originalText || isRegenerating) return;

  const input = document.getElementById('regenerate-input') as HTMLInputElement;
  const instructions = input?.value.trim() || '';

  vscode.postMessage({
    type: 'requestRegenerate',
    instructions
  } as WebviewMessage);
}

/**
 * Calculate ORP (Optimal Recognition Point) position
 */
function calculateORP(word: string): number {
  const cleanWord = word.replace(/[.,!?;:]$/, '');
  const length = cleanWord.length;

  if (length <= 1) return 0;
  if (length <= 3) return 1;
  return Math.floor(length * 0.33);
}

/**
 * Calculate word display delay based on WPM and punctuation
 */
function calculateWordDelay(word: string, wpm: number): number {
  const baseDelay = (60 / wpm) * 1000;

  if (/[.!?]$/.test(word)) return baseDelay * 2.0;
  if (/[,;:]$/.test(word)) return baseDelay * 1.5;

  return baseDelay;
}

/**
 * Display a word with ORP highlighting
 */
function displayWord(word: string) {
  const displayEl = document.getElementById('word-display');
  if (!displayEl) return;

  const orpIndex = calculateORP(word);
  const before = word.slice(0, orpIndex);
  const orp = word[orpIndex] || '';
  const after = word.slice(orpIndex + 1);

  displayEl.innerHTML = `
    <span class="word-before">${before}</span><span class="orp-char">${orp}</span><span class="word-after">${after}</span>
  `.trim();
}

/**
 * Play next word and schedule subsequent word
 */
function nextWord() {
  if (!state.isPlaying || state.currentIndex >= state.words.length) {
    pause();
    return;
  }

  const word = state.words[state.currentIndex];
  displayWord(word);
  updateProgress();

  const delay = calculateWordDelay(word, state.wpm);
  timerId = window.setTimeout(() => {
    state.currentIndex++;
    saveState();
    nextWord();
  }, delay);
}

/**
 * Start playback
 */
function play() {
  if (state.words.length === 0 || state.currentIndex >= state.words.length) {
    return;
  }

  state.isPlaying = true;
  saveState();
  updateUI();
  nextWord();
}

/**
 * Pause playback
 */
function pause() {
  state.isPlaying = false;

  if (timerId !== undefined) {
    clearTimeout(timerId);
    timerId = undefined;
  }

  saveState();
  updateUI();
}

/**
 * Stop playback and reset to beginning
 */
function stop() {
  pause();
  state.currentIndex = 0;
  saveState();
  updateUI();

  const displayEl = document.getElementById('word-display');
  if (displayEl) displayEl.innerHTML = '';
}

/**
 * Toggle play/pause
 */
function togglePlayPause() {
  if (state.isPlaying) {
    pause();
  } else {
    play();
  }
}

/**
 * Restart from beginning
 */
function restart() {
  pause();
  state.currentIndex = 0;
  saveState();
  updateUI();

  if (state.words.length > 0) {
    displayWord(state.words[0]);
  }
}

/**
 * Go to previous word
 */
function prevWord() {
  if (state.words.length === 0 || state.currentIndex <= 0) return;
  pause();
  state.currentIndex--;
  saveState();
  displayWord(state.words[state.currentIndex]);
  updateProgress();
}

/**
 * Go to next word (manual navigation)
 */
function nextWordManual() {
  if (state.words.length === 0 || state.currentIndex >= state.words.length - 1) return;
  pause();
  state.currentIndex++;
  saveState();
  displayWord(state.words[state.currentIndex]);
  updateProgress();
}

/**
 * Set reading speed (WPM)
 */
function setSpeed(wpm: number) {
  state.wpm = Math.max(100, Math.min(900, wpm));
  saveState();
  updateSpeedDisplay();
}

/**
 * Adjust speed by delta
 */
function adjustSpeed(delta: number) {
  setSpeed(state.wpm + delta);
}

/**
 * Update speed display
 */
function updateSpeedDisplay() {
  const speedDisplay = document.getElementById('speed-display');
  if (speedDisplay) {
    speedDisplay.textContent = state.wpm.toString();
  }
}

/**
 * Update UI to reflect current state
 */
function updateUI() {
  const playBtn = document.getElementById('play-btn');
  const displayEl = document.getElementById('word-display');
  const fullTextDisplay = document.getElementById('full-text-display');
  const emptyState = document.getElementById('empty-state');
  const controls = document.querySelector('.controls');
  const focusContainer = document.querySelector('.focus-container');
  const controlsSection = document.querySelector('.controls-section');
  const charCounts = document.getElementById('char-counts');
  const toggleContentBtn = document.getElementById('toggle-content-btn');
  const toggleModeBtn = document.getElementById('toggle-mode-btn');
  const regenerateSection = document.getElementById('regenerate-section');
  const regenerateBtn = document.getElementById('regenerate-btn');
  const regenerateInput = document.getElementById('regenerate-input') as HTMLInputElement;
  const playingStopBtn = document.getElementById('playing-stop-btn');

  // Update button text
  if (playBtn) {
    playBtn.innerHTML = state.isPlaying ? '⏸ Pause' : '▶ Play';
  }

  updateSpeedDisplay();
  updateProgress();

  // Toggle distraction-free mode when playing
  if (state.isPlaying && isRsvpMode) {
    regenerateSection?.classList.add('hidden-playing');
    controlsSection?.classList.add('hidden-playing');
    focusContainer?.classList.add('playing-centered');
    playingStopBtn?.classList.add('visible');
  } else {
    regenerateSection?.classList.remove('hidden-playing');
    controlsSection?.classList.remove('hidden-playing');
    focusContainer?.classList.remove('playing-centered');
    playingStopBtn?.classList.remove('visible');
  }

  // Show/hide based on content
  if (state.words.length === 0) {
    if (emptyState) emptyState.style.display = 'block';
    if (focusContainer) (focusContainer as HTMLElement).style.display = 'none';
    if (fullTextDisplay) fullTextDisplay.style.display = 'none';
    if (controlsSection) (controlsSection as HTMLElement).style.display = 'none';
    if (regenerateSection) regenerateSection.style.display = 'none';
    if (displayEl) displayEl.innerHTML = '';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (controlsSection) (controlsSection as HTMLElement).style.display = 'flex';

    // Toggle content button visibility (only when we have original)
    // Label shows CURRENT state, not what it switches to
    if (toggleContentBtn) {
      toggleContentBtn.style.display = originalText ? 'block' : 'none';
      const label = toggleContentBtn.querySelector('.toggle-label');
      if (label) label.textContent = isShowingOriginal ? 'Original' : 'Explanation';
    }

    // Toggle mode button - always visible when content loaded, shows CURRENT state
    if (toggleModeBtn) {
      toggleModeBtn.style.display = 'block';
      const label = toggleModeBtn.querySelector('.toggle-label');
      if (label) label.textContent = isRsvpMode ? 'RSVP' : 'Full Text';
    }

    // Show/hide based on reading mode
    const wpmDisplay = document.querySelector('.wpm-display');
    const speedControl = document.querySelector('.speed-control');
    const progress = document.getElementById('progress');

    if (isRsvpMode) {
      // RSVP mode
      if (focusContainer) (focusContainer as HTMLElement).style.display = 'flex';
      if (fullTextDisplay) fullTextDisplay.style.display = 'none';
      if (controls) (controls as HTMLElement).style.display = 'flex';
      if (wpmDisplay) (wpmDisplay as HTMLElement).style.display = 'block';
      if (speedControl) (speedControl as HTMLElement).style.display = 'flex';
      if (progress) progress.style.display = 'block';

      // Display current word or completion
      if (state.currentIndex < state.words.length && !state.isPlaying) {
        displayWord(state.words[state.currentIndex]);
      } else if (state.currentIndex >= state.words.length) {
        if (displayEl) {
          displayEl.innerHTML = iconUri
            ? `<img src="${iconUri}" class="completion-icon" alt="Done" />`
            : '<span class="completion-message">Done!</span>';
        }
      }
    } else {
      // Full text mode
      if (focusContainer) (focusContainer as HTMLElement).style.display = 'none';
      if (fullTextDisplay) {
        fullTextDisplay.style.display = 'block';
        const textToShow = isShowingOriginal ? originalText : currentText;
        fullTextDisplay.textContent = textToShow || '';
      }
      if (controls) (controls as HTMLElement).style.display = 'none';
      if (wpmDisplay) (wpmDisplay as HTMLElement).style.display = 'none';
      if (speedControl) (speedControl as HTMLElement).style.display = 'none';
      if (progress) progress.style.display = 'none';
    }

    // Word counts
    if (charCounts) {
      if (originalText) {
        const currentWords = currentText.split(/\s+/).filter(w => w.length > 0).length;
        const originalWords = originalText.split(/\s+/).filter(w => w.length > 0).length;
        charCounts.innerHTML = `<span class="char-count">${currentWords.toLocaleString()} words</span> · <span class="char-count">${originalWords.toLocaleString()} original</span>`;
        charCounts.style.display = 'block';
      } else {
        const wordCount = currentText.split(/\s+/).filter(w => w.length > 0).length;
        charCounts.innerHTML = `<span class="char-count">${wordCount.toLocaleString()} words</span>`;
        charCounts.style.display = 'block';
      }
    }

    // Regenerate section - only visible when we have an explanation (originalText exists)
    if (regenerateSection) {
      regenerateSection.style.display = originalText ? 'flex' : 'none';
    }
    if (regenerateBtn) {
      regenerateBtn.disabled = isRegenerating;
      regenerateBtn.textContent = isRegenerating ? '...' : '↻';
    }
    if (regenerateInput) {
      regenerateInput.disabled = isRegenerating;
    }
    const regenerateStatus = document.getElementById('regenerate-status');
    if (regenerateStatus) {
      regenerateStatus.textContent = isRegenerating ? 'Regenerating...' : '';
    }
  }
}

/**
 * Update progress indicator
 */
function updateProgress() {
  const progressEl = document.getElementById('progress');
  if (progressEl) {
    const current = Math.min(state.currentIndex + 1, state.words.length);
    progressEl.textContent = `${current} / ${state.words.length}`;
  }
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboard(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement) {
    return;
  }

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'KeyR':
      e.preventDefault();
      restart();
      break;
    case 'KeyO':
      e.preventDefault();
      if (originalText) toggleContent();
      break;
    case 'KeyF':
      e.preventDefault();
      toggleReadingMode();
      break;
    case 'ArrowUp':
      e.preventDefault();
      adjustSpeed(50);
      break;
    case 'ArrowDown':
      e.preventDefault();
      adjustSpeed(-50);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      prevWord();
      break;
    case 'ArrowRight':
      e.preventDefault();
      nextWordManual();
      break;
  }
}

/**
 * Debounced state save
 */
function saveState() {
  if (saveTimeout !== undefined) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = window.setTimeout(() => {
    vscode.setState(state);
  }, 300);
}
