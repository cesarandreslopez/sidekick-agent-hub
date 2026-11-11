/**
 * The replay bar of the pop-out panel: play/pause, speed, a scrubber over the
 * session with an activity-density strip and fault/prompt ticks, and the
 * time readout.
 *
 * @module webview/activityMap/controls
 */

import type { ActivityMarker } from 'sidekick-shared/activity';
import { formatClock, formatOffset } from './format';
import type { ActivityRange } from './model';
import type { PlaybackMode, PlaybackSpeed } from './playback';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RANGE_STEPS = 1000;
export const DENSITY_BUCKETS = 200;

export interface ReplayControlsHandlers {
  onToggle(): void;
  onSpeed(speed: PlaybackSpeed): void;
  onSeek(at: number): void;
}

export interface ReplayControlsState {
  range: ActivityRange | null;
  mode: PlaybackMode;
  cursor: number;
  speed: PlaybackSpeed;
}

export class ReplayControls {
  private range: ActivityRange | null = null;
  private stripKey = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly play: HTMLButtonElement,
    private readonly input: HTMLInputElement,
    private readonly strip: SVGSVGElement,
    private readonly time: HTMLElement,
    private readonly speeds: HTMLButtonElement[],
    handlers: ReplayControlsHandlers,
  ) {
    play.addEventListener('click', () => handlers.onToggle());
    for (const button of speeds) {
      button.addEventListener('click', () => {
        const speed = Number(button.dataset.speed);
        if (speed === 1 || speed === 10 || speed === 60) handlers.onSpeed(speed);
      });
    }
    input.addEventListener('input', () => {
      const range = this.range;
      if (!range) return;
      const fraction = Number(input.value) / RANGE_STEPS;
      handlers.onSeek(range.startAt + fraction * (range.endAt - range.startAt));
    });
  }

  update(state: ReplayControlsState): void {
    this.range = state.range;
    this.root.hidden = state.range === null;
    if (!state.range) return;
    const { startAt, endAt } = state.range;
    const span = Math.max(1, endAt - startAt);
    const at = state.mode === 'live' ? endAt : state.cursor;
    const value = Math.round(((at - startAt) / span) * RANGE_STEPS);
    if (document.activeElement !== this.input) this.input.value = String(value);
    const readout = `${formatClock(at)} · ${formatOffset(at - startAt)}`;
    this.time.textContent = state.mode === 'live' ? `${readout} · live` : readout;
    this.input.setAttribute('aria-valuetext', readout);
    const playing = state.mode === 'playing';
    this.play.textContent = playing ? '❚❚' : '▶';
    this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    for (const button of this.speeds) {
      button.setAttribute(
        'aria-pressed',
        Number(button.dataset.speed) === state.speed ? 'true' : 'false',
      );
    }
  }

  /** Redraws the density strip and ticks when the data changed. */
  updateStrip(key: string, density: readonly number[], markers: readonly ActivityMarker[]): void {
    if (key === this.stripKey || !this.range) return;
    this.stripKey = key;
    const doc = this.strip.ownerDocument;
    const nodes: SVGElement[] = [];
    const max = Math.max(1, ...density);
    density.forEach((count, index) => {
      if (count === 0) return;
      const height = Math.max(1.5, (count / max) * 12);
      const rect = doc.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'am-density');
      rect.setAttribute('x', String(index * (DENSITY_BUCKETS / density.length)));
      rect.setAttribute('y', String(14 - height));
      rect.setAttribute('width', '0.8');
      rect.setAttribute('height', String(height));
      nodes.push(rect);
    });
    const { startAt, endAt } = this.range;
    const span = Math.max(1, endAt - startAt);
    for (const marker of markers) {
      if (marker.kind !== 'fault' && marker.kind !== 'prompt') continue;
      const rect = doc.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', marker.kind === 'fault' ? 'am-tick-fault' : 'am-tick-prompt');
      rect.setAttribute('x', String(((marker.at - startAt) / span) * DENSITY_BUCKETS));
      rect.setAttribute('y', marker.kind === 'fault' ? '0' : '14');
      rect.setAttribute('width', '0.6');
      rect.setAttribute('height', '2');
      nodes.push(rect);
    }
    this.strip.replaceChildren(...nodes);
  }
}
