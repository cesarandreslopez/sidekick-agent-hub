/**
 * The `sidekick.activityMap.*` settings, read through an injected getter so
 * the parsing unit-tests without a `vscode` mock.
 *
 * - `motion`, `layout`, `coreName` shape the drawing (webview side).
 * - `labels`, `memory`, `stationOverrides` shape classification (recorder
 *   side); they apply to events observed after a change.
 *
 * @module utils/activityMapSettings
 */

import { isActivityStationId } from 'sidekick-shared';
import type {
  ActivityLabelMode,
  ActivityLayout,
  ActivityRecorderOptions,
  ActivityStationId,
  ProviderId,
} from 'sidekick-shared';

export type ActivityMapMotionSetting = 'auto' | 'full' | 'reduced' | 'none';

export interface ActivityMapSettings {
  motion: ActivityMapMotionSetting;
  layout: ActivityLayout;
  /** Empty: the renderer's default for the provider. */
  coreName: string;
  labels: ActivityLabelMode;
  memory: { paths: string[]; mcpServers: string[]; commands: string[] };
  /** Tool name (`Bash`, `mcp__srv__tool`) or `mcp__srv__*` → station. */
  stationOverrides: Record<string, ActivityStationId>;
}

export const ACTIVITY_MAP_SETTINGS_SECTION = 'sidekick.activityMap';

export const DEFAULT_ACTIVITY_MAP_SETTINGS: ActivityMapSettings = {
  motion: 'auto',
  layout: 'you-top',
  coreName: '',
  labels: 'descriptive',
  memory: { paths: [], mcpServers: [], commands: [] },
  stationOverrides: {},
};

/** Reads one key of the `sidekick.activityMap` section. */
export type SettingGetter = (key: string) => unknown;

const MOTIONS: readonly ActivityMapMotionSetting[] = ['auto', 'full', 'reduced', 'none'];
const LAYOUTS: readonly ActivityLayout[] = ['you-top', 'you-bottom'];
const LABELS: readonly ActivityLabelMode[] = ['names', 'descriptive', 'none'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readActivityMapSettings(get: SettingGetter): ActivityMapSettings {
  const memory = get('memory');
  const memoryRecord =
    memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {};
  const overrides = get('stationOverrides');
  const stationOverrides: Record<string, ActivityStationId> = {};
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, station] of Object.entries(overrides as Record<string, unknown>)) {
      const name = key.trim();
      if (name && isActivityStationId(station)) stationOverrides[name] = station;
    }
  }
  const coreName = get('coreName');
  return {
    motion: pick(get('motion'), MOTIONS, DEFAULT_ACTIVITY_MAP_SETTINGS.motion),
    layout: pick(get('layout'), LAYOUTS, DEFAULT_ACTIVITY_MAP_SETTINGS.layout),
    coreName: typeof coreName === 'string' ? coreName.trim().slice(0, 10) : '',
    labels: pick(get('labels'), LABELS, DEFAULT_ACTIVITY_MAP_SETTINGS.labels),
    memory: {
      paths: strings(memoryRecord.paths),
      mcpServers: strings(memoryRecord.mcpServers),
      commands: strings(memoryRecord.commands),
    },
    stationOverrides,
  };
}

/** `mcp__<server>__*` names a whole server; any other key names one tool. */
const SERVER_GLOB = /^mcp__(.+)__\*$/;

export type ActivityClassificationOptions = Omit<
  ActivityRecorderOptions,
  'providerId' | 'sessionId'
>;

/** Recorder options for the monitor's log (context comes from the host). */
export function toRecorderOptions(
  settings: ActivityMapSettings,
  providerId: ProviderId,
  sessionId?: string | null,
): ActivityRecorderOptions {
  return {
    providerId,
    ...(sessionId ? { sessionId } : {}),
    ...toClassificationOptions(settings),
  };
}

/** Labels, memory and station overrides, without a provider or session. */
export function toClassificationOptions(
  settings: ActivityMapSettings,
): ActivityClassificationOptions {
  const servers: Record<string, ActivityStationId> = {};
  const tools: Record<string, ActivityStationId> = {};
  for (const [key, station] of Object.entries(settings.stationOverrides)) {
    const server = SERVER_GLOB.exec(key)?.[1];
    if (server) servers[server] = station;
    else tools[key] = station;
  }
  const memory: NonNullable<ActivityRecorderOptions['memory']> = {};
  if (settings.memory.paths.length > 0) memory.paths = settings.memory.paths;
  if (settings.memory.mcpServers.length > 0) {
    // The shared default (`memory`) keeps counting alongside the user's servers.
    memory.servers = ['memory', ...settings.memory.mcpServers];
  }
  if (settings.memory.commands.length > 0) memory.commands = settings.memory.commands;
  return {
    labels: settings.labels,
    deriveContext: false,
    ...(Object.keys(servers).length > 0 || Object.keys(tools).length > 0
      ? {
          stationOverrides: {
            ...(Object.keys(servers).length > 0 ? { servers } : {}),
            ...(Object.keys(tools).length > 0 ? { tools } : {}),
          },
        }
      : {}),
    ...(Object.keys(memory).length > 0 ? { memory } : {}),
  };
}
