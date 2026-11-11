/**
 * The activity map's colors and the CSS that themes it.
 *
 * Pure.
 *
 * @module activity/render/palette
 */

import type { ActivityStationId } from '../stations';
import type { ActivityPalette, ActivityPaletteRole } from '../types';

export const ACTIVITY_PALETTE_ROLES: readonly ActivityPaletteRole[] = [
  'ground',
  'raised',
  'line',
  'spoke',
  'text',
  'muted',
  'dim',
  'accent',
  'hot',
  'fault',
  'warn',
  'memory',
  'memoryHot',
];

export interface ActivityCssVariable {
  /** Full custom property name, e.g. `--sidekick-activity-accent`. */
  name: string;
  role: ActivityPaletteRole | `station-${ActivityStationId}`;
  dark: string;
  light: string;
}

// Placeholders until the palettes are designed (workstream R replaces them).
export const ACTIVITY_DARK_PALETTE: ActivityPalette = {} as ActivityPalette;
export const ACTIVITY_LIGHT_PALETTE: ActivityPalette = {} as ActivityPalette;

/** Every custom property a `css-vars` SVG reads, with its dark and light defaults. */
export function listActivityCssVariables(_options?: { varPrefix?: string }): ActivityCssVariable[] {
  throw new Error('activity/render/palette: not implemented');
}

/** Class rules that paint a `css-vars` SVG; for hosts that pass `embedStyles: false`. */
export function activityMapStyles(_options?: { classPrefix?: string; varPrefix?: string }): string {
  throw new Error('activity/render/palette: not implemented');
}
