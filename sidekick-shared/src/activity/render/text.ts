/**
 * Lays the activity map out as rows of tone-tagged text for terminals.
 * The host colors and escapes the segments.
 *
 * Pure and deterministic.
 *
 * @module activity/render/text
 */

import type { ActivitySnapshot, ActivityTextLayout, LayoutActivityMapTextOptions } from '../types';

export function layoutActivityMapText(
  _snapshot: ActivitySnapshot,
  _options: LayoutActivityMapTextOptions,
): ActivityTextLayout {
  throw new Error('activity/render/text: not implemented');
}
