/**
 * Options handed from the extension to the Activity Map bundle in a
 * `<script type="application/json">` block (records follow by message).
 *
 * @module webview/activityMap/init
 */

import { isActivityStationId } from 'sidekick-shared/activity';
import { ACTIVITY_MAP_INIT_ELEMENT_ID, ACTIVITY_MAP_PROTOCOL } from '../../types/activityMap';
import type {
  ActivityMapFocus,
  ActivityMapInit,
  ActivityMapMode,
  ActivityMapViewOptions,
} from '../../types/activityMap';

/** Minimal document surface, so the reader is testable without a DOM. */
export interface InitDocument {
  getElementById(id: string): { textContent: string | null } | null;
}

export const DEFAULT_VIEW_OPTIONS: ActivityMapViewOptions = {
  motion: 'auto',
  reduceMotion: 'auto',
  layout: 'you-top',
  coreName: '',
};

export function defaultActivityMapInit(mode: ActivityMapMode = 'sidebar'): ActivityMapInit {
  return { protocol: ACTIVITY_MAP_PROTOCOL, mode, options: { ...DEFAULT_VIEW_OPTIONS } };
}

export function parseViewOptions(value: unknown): ActivityMapViewOptions {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const motion = raw.motion;
  const reduce = raw.reduceMotion;
  const layout = raw.layout;
  return {
    motion:
      motion === 'full' || motion === 'reduced' || motion === 'none' || motion === 'auto'
        ? motion
        : DEFAULT_VIEW_OPTIONS.motion,
    reduceMotion: reduce === 'on' || reduce === 'off' ? reduce : 'auto',
    layout: layout === 'you-bottom' ? 'you-bottom' : 'you-top',
    coreName: typeof raw.coreName === 'string' ? raw.coreName.slice(0, 10) : '',
  };
}

function parseFocus(value: unknown): ActivityMapFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const focus: ActivityMapFocus = {};
  if (typeof raw.at === 'number' && Number.isFinite(raw.at)) focus.at = raw.at;
  if (isActivityStationId(raw.station)) focus.station = raw.station;
  return focus.at !== undefined || focus.station ? focus : undefined;
}

/** Parses the embedded block; a missing or malformed one yields the defaults. */
export function readActivityMapInit(doc: InitDocument): ActivityMapInit {
  const text = doc.getElementById(ACTIVITY_MAP_INIT_ELEMENT_ID)?.textContent;
  if (!text) return defaultActivityMapInit();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const mode: ActivityMapMode = parsed.mode === 'panel' ? 'panel' : 'sidebar';
    const focus = parseFocus(parsed.focus);
    return {
      protocol: ACTIVITY_MAP_PROTOCOL,
      mode,
      options: parseViewOptions(parsed.options),
      ...(focus ? { focus } : {}),
    };
  } catch {
    return defaultActivityMapInit();
  }
}
