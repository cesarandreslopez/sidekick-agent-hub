/**
 * The stations of the activity map, in ring order, and the wire version of
 * every activity record, snapshot and insight.
 *
 * Pure: constants only.
 *
 * @module activity/stations
 */

/**
 * Ring order, clockwise from the top. `plan` sits next to `you`, so the
 * person and their plan are neighbours and the network faces them.
 */
export const ACTIVITY_STATIONS = [
  'you',
  'model',
  'memory',
  'files',
  'shell',
  'network',
  'browser',
  'agents',
  'skills',
  'hooks',
  'plan',
] as const;

export type ActivityStationId = (typeof ACTIVITY_STATIONS)[number];

/** Version of the activity record, snapshot, insights and export shapes. */
export const ACTIVITY_SCHEMA_VERSION = 1;

/**
 * CSS custom properties an embedding page may set to theme an SVG rendered
 * with `theme: 'css-vars'`. Each falls back to the dark palette.
 */
export const ACTIVITY_CSS_VAR_PREFIX = '--sidekick-activity-';

const STATION_SET: ReadonlySet<string> = new Set(ACTIVITY_STATIONS);

export function isActivityStationId(value: unknown): value is ActivityStationId {
  return typeof value === 'string' && STATION_SET.has(value);
}
