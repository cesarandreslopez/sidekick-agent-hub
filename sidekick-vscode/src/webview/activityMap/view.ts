/**
 * The map itself: swaps in each rendered SVG in one step, keeps hover and
 * selection across swaps, shows the station tooltip, and pauses animations
 * while the document is hidden.
 *
 * Every swap replaces the whole `<svg>`, so its animation timeline restarts
 * at 0 — exactly what the renderer's negative `begin` offsets (computed from
 * `now`) expect: a redraw continues every pulse where it was.
 *
 * @module webview/activityMap/view
 */

import { isActivityStationId } from 'sidekick-shared/activity';
import type { ActivityStationId } from 'sidekick-shared/activity';
import { placeTooltip } from './tooltip';

export interface MapViewHandlers {
  onSelect(station: ActivityStationId): void;
  /** Tooltip text for a station. */
  describe(station: ActivityStationId): string;
}

export class MapView {
  private hovered: ActivityStationId | undefined;
  private lastPointer: { x: number; y: number } | undefined;
  private paused = false;
  private lastLabel = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly tooltip: HTMLElement,
    private readonly handlers: MapViewHandlers,
  ) {
    container.addEventListener('pointermove', (event) => this.onPointer(event));
    container.addEventListener('pointerleave', () => this.hideTooltip());
    container.addEventListener('click', (event) => {
      const station = this.stationAt(event.target);
      if (station) handlers.onSelect(station);
    });
  }

  /** Replaces the drawing. `label` becomes the map's accessible name. */
  render(svg: string, label: string): void {
    this.container.innerHTML = svg;
    if (label !== this.lastLabel) {
      this.container.setAttribute('aria-label', label);
      this.lastLabel = label;
    }
    const root = this.svg();
    if (root) {
      // Stations get the richer custom tooltip; their native SVG titles would double it.
      root.querySelectorAll('[data-station] > title').forEach((title) => title.remove());
      if (this.paused) pauseSvg(root);
    }
    if (this.hovered) this.showTooltip(this.hovered);
  }

  /** Stops (or resumes) SMIL animations, e.g. while the view is hidden. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const root = this.svg();
    if (!root) return;
    if (paused) pauseSvg(root);
    else resumeSvg(root);
  }

  private svg(): SVGSVGElement | null {
    return this.container.querySelector('svg');
  }

  private stationAt(target: EventTarget | null): ActivityStationId | undefined {
    const element = target instanceof Element ? target.closest('[data-station]') : null;
    const station = element?.getAttribute('data-station');
    return isActivityStationId(station) ? station : undefined;
  }

  private onPointer(event: PointerEvent): void {
    this.lastPointer = { x: event.clientX, y: event.clientY };
    const station = this.stationAt(event.target);
    if (station !== this.hovered) {
      this.hovered = station;
      if (!station) {
        this.hideTooltip();
        return;
      }
    }
    if (station) this.showTooltip(station);
  }

  private showTooltip(station: ActivityStationId): void {
    const text = this.handlers.describe(station);
    if (this.tooltip.textContent !== text) this.tooltip.textContent = text;
    this.tooltip.hidden = false;
    if (this.lastPointer) {
      const view = this.container.ownerDocument.defaultView;
      placeTooltip(this.tooltip, this.lastPointer.x, this.lastPointer.y, {
        width: view?.innerWidth ?? 800,
        height: view?.innerHeight ?? 600,
      });
    }
  }

  private hideTooltip(): void {
    this.hovered = undefined;
    this.tooltip.hidden = true;
  }
}

function pauseSvg(root: SVGSVGElement): void {
  if (typeof root.pauseAnimations === 'function') root.pauseAnimations();
}

function resumeSvg(root: SVGSVGElement): void {
  if (typeof root.unpauseAnimations === 'function') root.unpauseAnimations();
}
