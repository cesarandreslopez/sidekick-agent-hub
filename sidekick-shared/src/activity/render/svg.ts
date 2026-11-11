/**
 * Draws the activity map as one self-contained SVG string.
 *
 * Pure and deterministic: the same snapshot and options give the same bytes.
 *
 * @module activity/render/svg
 */

import type { ActivitySnapshot, RenderActivityMapSvgOptions } from '../types';

export function renderActivityMapSvg(
  _snapshot: ActivitySnapshot,
  _options: RenderActivityMapSvgOptions,
): string {
  throw new Error('activity/render/svg: not implemented');
}
