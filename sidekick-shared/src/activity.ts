/**
 * `sidekick-shared/activity` — the activity map: a provider-neutral,
 * replayable picture of what a coding agent is doing, station by station.
 *
 * - {@link createActivityRecorder} turns canonical session events (Claude
 *   Code, Codex, OpenCode) into content-free, classified records — the wire
 *   format: labels carry names, never content.
 * - One reducer ({@link createActivityState} / {@link applyActivityRecord})
 *   folds records into full-session totals and a bounded drawing view, live
 *   or replayed; {@link createActivityTimeline} adds scrubbing.
 * - {@link snapshotActivity} and {@link summarizeActivity} give the view and
 *   the statistics; {@link renderActivityMapSvg}, {@link layoutActivityMapText}
 *   and the describe helpers draw and narrate them.
 *
 * Pure, synchronous and deterministic: no clock, no filesystem, no Zod. The
 * wire schemas live in `sidekick-shared/schemas`; replaying a session file is
 * `replayActivity` in `sidekick-shared/node`. Everything here is also
 * exported from the package root.
 *
 * @module activity
 */

export {
  ACTIVITY_CSS_VAR_PREFIX,
  ACTIVITY_SCHEMA_VERSION,
  ACTIVITY_STATIONS,
  isActivityStationId,
} from './activity/stations';
export {
  ACTIVITY_LABEL_KEYS,
  DEFAULT_ACTIVITY_STRINGS,
  resolveActivityStrings,
} from './activity/strings';
export { activityHostLabel, activityPathLabel, cleanActivityLabel } from './activity/labels';
export { classifyActivityShell, classifyActivityTool } from './activity/classify';
export { createActivityRecorder } from './activity/recorder';
export {
  applyActivityRecord,
  applyActivityRecords,
  cloneActivityState,
  createActivityState,
  restoreActivityState,
  snapshotActivity,
} from './activity/state';
export { summarizeActivity } from './activity/insights';
export {
  buildActivitySnapshot,
  createActivityTimeline,
  exportActivity,
  normalizeActivityRecords,
} from './activity/timeline';
export { foldActivityFeed } from './activity/feed';
export {
  describeActivityInsights,
  describeActivityNow,
  describeActivityPattern,
} from './activity/describe';
export {
  ACTIVITY_DARK_PALETTE,
  ACTIVITY_LIGHT_PALETTE,
  ACTIVITY_PALETTE_ROLES,
  activityMapStyles,
  listActivityCssVariables,
} from './activity/render/palette';
export { renderActivityMapSvg } from './activity/render/svg';
export { layoutActivityMapText } from './activity/render/text';
export type { ActivityCssVariable } from './activity/render/palette';
export type { ActivityLabelKey, ActivityStrings } from './activity/strings';
export type { ActivityStationId } from './activity/stations';
export type {
  ActivityAgentSnapshot,
  ActivityAlternationPattern,
  ActivityClassification,
  ActivityClassifyOptions,
  ActivityCompactionRecord,
  ActivityContextObservation,
  ActivityContextRecord,
  ActivityContextSnapshot,
  ActivityContextSource,
  ActivityDeniedBy,
  ActivityEntry,
  ActivityEntryMark,
  ActivityEventSource,
  ActivityExport,
  ActivityFeedOptions,
  ActivityFeedRow,
  ActivityHint,
  ActivityHookOutcome,
  ActivityHookRecord,
  ActivityInboundRecord,
  ActivityInsights,
  ActivityLabelCount,
  ActivityLabelMode,
  ActivityLayout,
  ActivityMarker,
  ActivityMarkerKind,
  ActivityMemoryOptions,
  ActivityMemoryPushedRecord,
  ActivityMemoryVia,
  ActivityModelSnapshot,
  ActivityMotion,
  ActivityOrigin,
  ActivityOutcome,
  ActivityPalette,
  ActivityPaletteRole,
  ActivityPattern,
  ActivityPromptRecord,
  ActivityRecord,
  ActivityRecordBase,
  ActivityRecordBatch,
  ActivityRecordKind,
  ActivityRecorder,
  ActivityRecorderOptions,
  ActivityRecorderState,
  ActivityRetryStreakPattern,
  ActivityRouteStop,
  ActivitySessionRecord,
  ActivitySlowCall,
  ActivitySnapshot,
  ActivityState,
  ActivityStateOptions,
  ActivityStationInsight,
  ActivityStationOverrides,
  ActivityStationSnapshot,
  ActivityStepRecord,
  ActivitySubagentEndRecord,
  ActivitySubagentStartRecord,
  ActivityTextLayout,
  ActivityTextSegment,
  ActivityTheme,
  ActivityTimeline,
  ActivityTimelineOptions,
  ActivityTone,
  ActivityToolEndRecord,
  ActivityToolStartRecord,
  ActivityTotals,
  ActivityTurnEndRecord,
  ActivityTurnOutcome,
  ActivityTurnSnapshot,
  DescribeActivityInsightsOptions,
  DescribeActivityOptions,
  LayoutActivityMapTextOptions,
  RenderActivityMapSvgOptions,
} from './activity/types';
