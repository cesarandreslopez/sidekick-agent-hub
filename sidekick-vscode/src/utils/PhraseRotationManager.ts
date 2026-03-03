/**
 * @fileoverview Reusable phrase rotation manager for webview providers.
 *
 * Eliminates duplicated _startPhraseTimers / _clearPhraseTimers logic
 * across DashboardViewProvider, TaskBoardViewProvider, MindMapViewProvider,
 * and ProjectTimelineViewProvider.
 *
 * @module utils/PhraseRotationManager
 */

import { getRandomPhrase } from 'sidekick-shared/dist/phrases';
import { PHRASE_ROTATION_INTERVAL, EMPTY_PHRASE_ROTATION_INTERVAL } from '../constants';

/**
 * Manages rotating phrase timers for webview providers.
 *
 * @example
 * ```typescript
 * const phrases = new PhraseRotationManager(msg => this._postMessage(msg));
 * phrases.start(() => this._state.sessionActive);
 * // ...
 * phrases.stop(); // in dispose()
 * ```
 */
/** Message types emitted by PhraseRotationManager. */
export type PhraseMessage =
  | { type: 'updatePhrase'; phrase: string }
  | { type: 'updateEmptyPhrase'; phrase: string };

export class PhraseRotationManager {
  private _phraseInterval?: ReturnType<typeof setInterval>;
  private _emptyPhraseInterval?: ReturnType<typeof setInterval>;

  /**
   * @param _postMessage - Callback to send messages to the webview.
   */
  constructor(
    private readonly _postMessage: (message: PhraseMessage) => void
  ) {}

  /**
   * Start rotating phrases at standard intervals.
   *
   * @param isSessionActive - Optional predicate; when provided, empty-state
   *   phrases are only sent when the session is inactive.
   */
  start(isSessionActive?: () => boolean): void {
    this.stop();

    this._phraseInterval = setInterval(() => {
      this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
    }, PHRASE_ROTATION_INTERVAL);

    this._emptyPhraseInterval = setInterval(() => {
      if (!isSessionActive || !isSessionActive()) {
        this._postMessage({ type: 'updateEmptyPhrase', phrase: getRandomPhrase() });
      }
    }, EMPTY_PHRASE_ROTATION_INTERVAL);
  }

  /** Stop all phrase rotation timers. */
  stop(): void {
    if (this._phraseInterval) {
      clearInterval(this._phraseInterval);
      this._phraseInterval = undefined;
    }
    if (this._emptyPhraseInterval) {
      clearInterval(this._emptyPhraseInterval);
      this._emptyPhraseInterval = undefined;
    }
  }
}
