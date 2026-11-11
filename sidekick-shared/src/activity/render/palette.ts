/**
 * The activity map's colors and the CSS that themes it.
 *
 * Two palettes, dark and light, share one set of roles. Each station has a
 * hue of its own, chosen so that neighbours on the ring differ strongly and
 * no station uses the fault red. Every hue keeps at least 3:1 contrast with
 * its palette's ground.
 *
 * A `css-vars` drawing paints through classes: `<prefix>-f-<key>` sets a
 * fill and `<prefix>-s-<key>` a stroke, where `<key>` is a role or
 * `st-<station>`. {@link activityMapStyles} maps each class to a custom
 * property (`--sidekick-activity-<role>`, `--sidekick-activity-station-<id>`)
 * with the dark color as fallback, so a host only sets the properties it
 * wants to change.
 *
 * Pure.
 *
 * @module activity/render/palette
 */

import { ACTIVITY_CSS_VAR_PREFIX, ACTIVITY_STATIONS } from '../stations';
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

export const ACTIVITY_DARK_PALETTE: ActivityPalette = {
  ground: '#100c1d',
  raised: '#1b1531',
  line: '#30284b',
  spoke: '#221b39',
  text: '#ece6f8',
  muted: '#a99cc6',
  dim: '#6f6590',
  accent: '#a98bff',
  hot: '#e6dcff',
  fault: '#ff5c74',
  warn: '#ffb547',
  memory: '#4fe0c2',
  memoryHot: '#b4f6e8',
  stations: {
    you: '#f7a8d8',
    model: '#b69cff',
    memory: '#4fe0c2',
    files: '#74a8ff',
    shell: '#9ad96b',
    network: '#45c8f0',
    browser: '#ffa25c',
    agents: '#e58cf0',
    skills: '#f4d35e',
    hooks: '#a8b8d0',
    plan: '#ffc59a',
  },
};

export const ACTIVITY_LIGHT_PALETTE: ActivityPalette = {
  ground: '#f8f6fc',
  raised: '#ffffff',
  line: '#d5cde6',
  spoke: '#e7e1f2',
  text: '#1d1730',
  muted: '#594e72',
  dim: '#8c82a6',
  accent: '#6a47d6',
  hot: '#35208c',
  fault: '#d42f48',
  warn: '#a86200',
  memory: '#0b8a74',
  memoryHot: '#065c4d',
  stations: {
    you: '#c23c80',
    model: '#6a47d6',
    memory: '#0b8a74',
    files: '#2d6bd4',
    shell: '#4a8a1c',
    network: '#0b7ba6',
    browser: '#cc5d08',
    agents: '#a23cb2',
    skills: '#8f7300',
    hooks: '#56677f',
    plan: '#9a5634',
  },
};

/** Merges a partial palette over a base, one level deep for `stations`. */
export function mergeActivityPalette(
  base: ActivityPalette,
  overrides?: Partial<ActivityPalette>,
): ActivityPalette {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    stations: { ...base.stations, ...overrides.stations },
  };
}

/** Every custom property a `css-vars` SVG reads, with its dark and light defaults. */
export function listActivityCssVariables(
  options: { varPrefix?: string } = {},
): ActivityCssVariable[] {
  const prefix = options.varPrefix ?? ACTIVITY_CSS_VAR_PREFIX;
  const out: ActivityCssVariable[] = ACTIVITY_PALETTE_ROLES.map((role) => ({
    name: `${prefix}${role}`,
    role,
    dark: ACTIVITY_DARK_PALETTE[role],
    light: ACTIVITY_LIGHT_PALETTE[role],
  }));
  for (const station of ACTIVITY_STATIONS) {
    out.push({
      name: `${prefix}station-${station}`,
      role: `station-${station}`,
      dark: ACTIVITY_DARK_PALETTE.stations[station],
      light: ACTIVITY_LIGHT_PALETTE.stations[station],
    });
  }
  return out;
}

/** Palette keys the renderer paints with: a role, or a station hue. */
export type ActivityPaintKey = ActivityPaletteRole | `st-${ActivityStationId}`;

export function activityPaintKeys(): ActivityPaintKey[] {
  return [
    ...ACTIVITY_PALETTE_ROLES,
    ...ACTIVITY_STATIONS.map((station) => `st-${station}` as const),
  ];
}

export function paletteColor(palette: ActivityPalette, key: ActivityPaintKey): string {
  return key.startsWith('st-')
    ? palette.stations[key.slice(3) as ActivityStationId]
    : palette[key as ActivityPaletteRole];
}

function varName(key: ActivityPaintKey, varPrefix: string): string {
  return key.startsWith('st-') ? `${varPrefix}station-${key.slice(3)}` : `${varPrefix}${key}`;
}

/**
 * Class rules that paint a `css-vars` SVG; for hosts that pass
 * `embedStyles: false` and put these rules in their own stylesheet.
 */
export function activityMapStyles(
  options: { classPrefix?: string; varPrefix?: string; palette?: Partial<ActivityPalette> } = {},
): string {
  const classPrefix = options.classPrefix ?? 'sam';
  const varPrefix = options.varPrefix ?? ACTIVITY_CSS_VAR_PREFIX;
  const palette = mergeActivityPalette(ACTIVITY_DARK_PALETTE, options.palette);
  return activityPaintKeys()
    .map((key) => {
      const value = `var(${varName(key, varPrefix)},${paletteColor(palette, key)})`;
      return `.${classPrefix}-f-${key}{fill:${value}}.${classPrefix}-s-${key}{stroke:${value}}`;
    })
    .join('');
}

/** Class rules that repaint an `auto` SVG on a light surface. */
export function activityLightOverrideRules(classPrefix: string, palette: ActivityPalette): string {
  return activityPaintKeys()
    .map((key) => {
      const value = paletteColor(palette, key);
      return `.${classPrefix}-f-${key}{fill:${value}}.${classPrefix}-s-${key}{stroke:${value}}`;
    })
    .join('');
}
