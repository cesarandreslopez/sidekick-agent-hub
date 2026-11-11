/**
 * Messages between the extension host and the Activity Map webview (the
 * sidebar view and the pop-out panel share them).
 *
 * The host sends the activity log as records numbered by `seq` within an
 * `epoch`: `activity/init` carries every record held and the state before
 * the first of them (what records the host dropped left behind),
 * `activity/append` the next run of them. A webview that sees a gap, or an epoch it does not hold,
 * asks for `activity/resync` and receives a fresh `activity/init`.
 *
 * Types only, imported by both sides.
 *
 * @module types/activityMap
 */

import type {
  ActivityLayout,
  ActivityRecord,
  ActivityState,
  ActivityStationId,
  ProviderId,
} from 'sidekick-shared';

export const ACTIVITY_MAP_PROTOCOL = 1;
export const ACTIVITY_MAP_INIT_ELEMENT_ID = 'sidekick-activity-map-init';

export type ActivityMapMode = 'sidebar' | 'panel';
export type ActivityMapMotion = 'auto' | 'full' | 'reduced' | 'none';

/** Drawing options the webview applies; classification happens on the host. */
export interface ActivityMapViewOptions {
  motion: ActivityMapMotion;
  /** `workbench.reduceMotion`; with `motion: 'auto'` it decides before the OS preference. */
  reduceMotion: 'on' | 'off' | 'auto';
  layout: ActivityLayout;
  /** Empty: the renderer's default for the provider. */
  coreName: string;
}

export interface ActivityMapSourceInfo {
  kind: 'live' | 'archive';
  providerId: ProviderId;
  sessionId?: string;
  /** Short human label, e.g. `Claude Code · 3f9a1c2e`. */
  label: string;
}

export interface ActivityMapFocus {
  /** Cursor to open at (epoch ms); the panel starts paused there. */
  at?: number;
  station?: ActivityStationId;
}

/** Embedded in the document as JSON; records arrive by message after `activity/ready`. */
export interface ActivityMapInit {
  protocol: typeof ACTIVITY_MAP_PROTOCOL;
  mode: ActivityMapMode;
  options: ActivityMapViewOptions;
  focus?: ActivityMapFocus;
}

export type ActivityMapHostMessage =
  | {
      type: 'activity/init';
      protocol: typeof ACTIVITY_MAP_PROTOCOL;
      source: ActivityMapSourceInfo;
      epoch: number;
      baseSeq: number;
      nextSeq: number;
      /** The state before `records[0]`: the host timeline's `base()`. */
      base: ActivityState;
      records: ActivityRecord[];
      /** Host clock when sent, for the webview's clock offset. */
      hostNow: number;
      live: boolean;
      focus?: ActivityMapFocus;
    }
  | {
      type: 'activity/append';
      epoch: number;
      fromSeq: number;
      records: ActivityRecord[];
      hostNow: number;
    }
  | { type: 'activity/state'; live: boolean; hostNow: number }
  | { type: 'activity/options'; options: ActivityMapViewOptions }
  | { type: 'activity/empty'; reason: 'noSession' };

export type ActivityMapWebviewMessage =
  | { type: 'activity/ready'; protocol: number }
  | { type: 'activity/resync'; reason: 'gap' | 'epoch' | 'protocol' }
  | { type: 'activity/popOut'; at?: number; station?: ActivityStationId }
  /** Without a format, the host asks which one. */
  | { type: 'activity/export'; format?: 'svg' | 'json'; at?: number }
  | { type: 'activity/openSettings' };
