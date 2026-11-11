/**
 * Replay state: following the live session, paused at a moment, or playing
 * through the session at 1×, 10× or 60×.
 *
 * Pure: the caller supplies elapsed local time and the session's range.
 *
 * @module webview/activityMap/playback
 */

import type { ActivityRange } from './model';

export type PlaybackMode = 'live' | 'paused' | 'playing';
export type PlaybackSpeed = 1 | 10 | 60;

export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 10, 60];
/** While playing with skip-idle on, quiet stretches longer than this are jumped. */
export const IDLE_GAP_MS = 30_000;
/** Lead-in kept before the next record when an idle stretch is skipped. */
const IDLE_LEAD_MS = 1_500;

export interface PlaybackState {
  mode: PlaybackMode;
  /** Session time shown (epoch ms); meaningless while live. */
  cursor: number;
  speed: PlaybackSpeed;
  skipIdle: boolean;
}

export class PlaybackController {
  state: PlaybackState;

  constructor(initial?: { at?: number }) {
    this.state =
      initial?.at !== undefined
        ? { mode: 'paused', cursor: initial.at, speed: 1, skipIdle: true }
        : { mode: 'live', cursor: 0, speed: 1, skipIdle: true };
  }

  get mode(): PlaybackMode {
    return this.state.mode;
  }

  /** The moment to draw: undefined means "the newest" (live). */
  cursorAt(): number | undefined {
    return this.state.mode === 'live' ? undefined : this.state.cursor;
  }

  goLive(): void {
    this.state = { ...this.state, mode: 'live' };
  }

  /** Pauses where playback is, or at `at`. Leaving live mode starts from the end. */
  pause(range: ActivityRange | null, at?: number): void {
    const cursor = at ?? (this.state.mode === 'live' ? (range?.endAt ?? 0) : this.state.cursor);
    this.state = { ...this.state, mode: 'paused', cursor: clamp(cursor, range) };
  }

  /** Plays from the cursor; from the start when at (or past) the end. */
  play(range: ActivityRange | null): void {
    if (!range) return;
    let cursor = this.state.mode === 'live' ? range.endAt : this.state.cursor;
    if (cursor >= range.endAt) cursor = range.startAt;
    this.state = { ...this.state, mode: 'playing', cursor: clamp(cursor, range) };
  }

  toggle(range: ActivityRange | null): void {
    if (this.state.mode === 'playing') this.pause(range);
    else this.play(range);
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.state = { ...this.state, speed };
  }

  setSkipIdle(skipIdle: boolean): void {
    this.state = { ...this.state, skipIdle };
  }

  /** Scrubbing always pauses (and leaves live mode). */
  seek(at: number, range: ActivityRange | null): void {
    this.state = { ...this.state, mode: 'paused', cursor: clamp(at, range) };
  }

  /** Moves the cursor by `deltaMs` of session time, pausing first. */
  step(deltaMs: number, range: ActivityRange | null): void {
    if (this.state.mode === 'live') this.pause(range);
    const mode = this.state.mode === 'playing' ? 'playing' : 'paused';
    this.state = { ...this.state, mode, cursor: clamp(this.state.cursor + deltaMs, range) };
  }

  /**
   * Advances a playing cursor by `elapsedLocalMs × speed`. At the end of a live
   * session it rejoins live mode; at the end of a finished one it pauses.
   */
  tick(
    elapsedLocalMs: number,
    range: ActivityRange | null,
    options: { live: boolean; nextRecordAfter?: (at: number) => number | undefined },
  ): void {
    if (this.state.mode !== 'playing' || !range) return;
    let cursor = this.state.cursor + Math.max(0, elapsedLocalMs) * this.state.speed;
    if (this.state.skipIdle && options.nextRecordAfter) {
      const next = options.nextRecordAfter(this.state.cursor);
      if (next !== undefined && next - cursor > IDLE_GAP_MS) cursor = next - IDLE_LEAD_MS;
    }
    if (cursor >= range.endAt) {
      if (options.live) {
        this.state = { ...this.state, mode: 'live', cursor: range.endAt };
      } else {
        this.state = { ...this.state, mode: 'paused', cursor: range.endAt };
      }
      return;
    }
    this.state = { ...this.state, cursor: clamp(cursor, range) };
  }
}

function clamp(at: number, range: ActivityRange | null): number {
  if (!range) return at;
  return Math.min(range.endAt, Math.max(range.startAt, at));
}
