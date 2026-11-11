/**
 * Zod schemas for the activity map's wire shapes: records, snapshots,
 * insights and exports (`schemaVersion: 1`).
 *
 * They mirror `activity/types.ts`. Labels are checked at the boundary: at
 * most 120 characters, no control, bidi or zero-width characters. Clients
 * must ignore pattern kinds they do not know; a new kind ships with a new
 * minor release and is added here.
 */

import * as z from 'zod';
import { ACTIVITY_STATIONS } from '../activity/stations';
import { ACTIVITY_LABEL_KEYS } from '../activity/strings';
import type {
  ActivityAlternationPattern,
  ActivityEntry,
  ActivityExport,
  ActivityInsights,
  ActivityPattern,
  ActivityRecord,
  ActivityRecordBatch,
  ActivityRetryStreakPattern,
  ActivitySnapshot,
  ActivityStationInsight,
  ActivityStationSnapshot,
} from '../activity/types';
import { SESSION_PROVIDER_IDS } from '../providerIds';

// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

export const activityStationIdSchema = z.enum(ACTIVITY_STATIONS);
export const activityLabelKeySchema = z.enum(ACTIVITY_LABEL_KEYS);
export const activityLabelSchema = z
  .string()
  .max(120)
  .refine((value) => !UNSAFE_LABEL.test(value), { message: 'label holds control characters' });

const providerIdSchema = z.enum(SESSION_PROVIDER_IDS);
const time = z.number().finite();
const count = z.number().int().nonnegative();
const outcomeSchema = z.enum(['ok', 'error', 'denied', 'cancelled', 'unknown']);
const deniedBySchema = z.enum(['user', 'hook', 'policy']);
const hintSchema = z.enum([
  'read',
  'edit',
  'search',
  'test',
  'build',
  'lint',
  'install',
  'vcs',
  'remote',
]);
const turnOutcomeSchema = z.enum(['done', 'aborted', 'error']);
const agentIdSchema = z.string().min(1).max(256);
const idSchema = z.string().min(1).max(512);

const base = {
  seq: count,
  at: time,
  agentId: agentIdSchema.optional(),
};

export const activityRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('session'),
    providerId: providerIdSchema,
    sessionId: z.string().max(256).optional(),
  }),
  z.object({ ...base, kind: z.literal('prompt') }),
  z.object({
    ...base,
    kind: z.literal('step'),
    model: z.string().max(128).optional(),
    startedAt: time.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('toolStart'),
    id: idSchema,
    station: activityStationIdSchema,
    label: activityLabelSchema,
    labelKey: activityLabelKeySchema.optional(),
    tool: activityLabelSchema,
    hint: hintSchema.optional(),
    fold: z.number().int().positive().optional(),
    instant: z.literal(true).optional(),
    spawn: z.literal(true).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('toolEnd'),
    id: idSchema,
    outcome: outcomeSchema,
    durationMs: z.number().nonnegative().optional(),
    resultChars: count.optional(),
    startedAt: time.optional(),
    deniedBy: deniedBySchema.optional(),
    asked: z.literal(true).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('hook'),
    hookEvent: z.string().min(1).max(64),
    toolUseId: idSchema.optional(),
    outcome: z.enum(['ok', 'error', 'blocked', 'context']),
    durationMs: z.number().nonnegative().optional(),
    contextChars: count.optional(),
    label: activityLabelSchema,
    labelKey: activityLabelKeySchema.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('memoryPushed'),
    label: activityLabelSchema,
    labelKey: activityLabelKeySchema.optional(),
    chars: count.optional(),
    via: z.enum(['attachment', 'hook', 'instructions']),
  }),
  z.object({
    ...base,
    kind: z.literal('inbound'),
    station: activityStationIdSchema,
    label: activityLabelSchema,
    labelKey: activityLabelKeySchema.optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('context'),
    percent: z.number().min(0).max(100),
    tokens: z.number().nonnegative().optional(),
    window: z.number().positive().optional(),
    source: z.enum(['usage', 'host']),
  }),
  z.object({
    ...base,
    kind: z.literal('compaction'),
    tokensBefore: count.optional(),
    tokensAfter: count.optional(),
    trigger: z.enum(['auto', 'manual']).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('subagentStart'),
    agentId: agentIdSchema,
    spawnId: idSchema.optional(),
    parentAgentId: agentIdSchema.optional(),
    label: activityLabelSchema,
  }),
  z.object({
    ...base,
    kind: z.literal('subagentEnd'),
    agentId: agentIdSchema,
    outcome: z.enum(['ok', 'error', 'cancelled']),
  }),
  z.object({ ...base, kind: z.literal('turnEnd'), outcome: turnOutcomeSchema }),
]) satisfies z.ZodType<ActivityRecord>;

export const activityRecordBatchSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: providerIdSchema,
  sessionId: z.string().max(256).optional(),
  records: z.array(activityRecordSchema),
}) satisfies z.ZodType<ActivityRecordBatch>;

export const activityEntrySchema = z.object({
  key: z.string().min(1).max(1024),
  station: activityStationIdSchema,
  label: activityLabelSchema,
  labelKey: activityLabelKeySchema.optional(),
  from: z.enum(['core', 'agents', 'inbound']),
  agentId: agentIdSchema.optional(),
  startedAt: time,
  endedAt: time.optional(),
  outcome: outcomeSchema.optional(),
  deniedBy: deniedBySchema.optional(),
  mark: z
    .enum(['prompt', 'done', 'aborted', 'switch', 'compaction', 'pushed', 'notification'])
    .optional(),
  fold: z.number().int().positive().optional(),
  hint: hintSchema.optional(),
  tool: activityLabelSchema.optional(),
}) satisfies z.ZodType<ActivityEntry>;

export const activityStationSnapshotSchema = z.object({
  id: activityStationIdSchema,
  count,
  running: count,
  runningSince: time.optional(),
  faults: count,
  lastAt: time.optional(),
  lastFaultAt: time.optional(),
  pushed: count.optional(),
}) satisfies z.ZodType<ActivityStationSnapshot>;

export const activityRetryStreakPatternSchema = z.object({
  kind: z.literal('retry-streak'),
  station: activityStationIdSchema,
  failures: count,
  startAt: time,
  endAt: time,
  state: z.enum(['open', 'recovered', 'abandoned']),
}) satisfies z.ZodType<ActivityRetryStreakPattern>;

export const activityAlternationPatternSchema = z.object({
  kind: z.literal('alternation'),
  stations: z.tuple([activityStationIdSchema, activityStationIdSchema]),
  cycles: count,
  startAt: time,
  endAt: time,
  state: z.enum(['open', 'closed']),
  flavor: z.literal('edit-test').optional(),
}) satisfies z.ZodType<ActivityAlternationPattern>;

export const activityPatternSchema = z.discriminatedUnion('kind', [
  activityRetryStreakPatternSchema,
  activityAlternationPatternSchema,
]) satisfies z.ZodType<ActivityPattern>;

export const activitySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: providerIdSchema.optional(),
  sessionId: z.string().max(256).optional(),
  at: time,
  startedAt: time.optional(),
  stations: z.array(activityStationSnapshotSchema),
  entries: z.array(activityEntrySchema),
  running: z.array(activityEntrySchema),
  agents: z.array(
    z.object({ agentId: agentIdSchema, label: activityLabelSchema, startedAt: time }),
  ),
  route: z.array(z.object({ station: activityStationIdSchema, at: time })),
  model: z
    .object({
      id: z.string().max(128),
      steps: count,
      switchedAt: time.optional(),
      previous: z.string().max(128).optional(),
    })
    .optional(),
  context: z
    .object({
      percent: z.number().min(0).max(100),
      tokens: z.number().nonnegative().optional(),
      window: z.number().positive().optional(),
      at: time,
      source: z.enum(['usage', 'host']),
    })
    .optional(),
  compactions: count,
  lastCompactionAt: time.optional(),
  turn: z.object({
    working: z.boolean(),
    since: time.optional(),
    thinkingSince: time.optional(),
    lastPromptAt: time.optional(),
    lastEnd: z.object({ at: time, outcome: turnOutcomeSchema }).optional(),
  }),
  patterns: z.array(activityPatternSchema),
  totals: z.object({
    prompts: count,
    calls: count,
    errors: count,
    denials: count,
    steps: count,
    pushed: count,
  }),
}) satisfies z.ZodType<ActivitySnapshot>;

export const activityStationInsightSchema = z.object({
  id: activityStationIdSchema,
  calls: count,
  errors: count,
  denials: count,
  cancelled: count,
  busyMs: z.number().nonnegative(),
  callMs: z.number().nonnegative(),
  shareOfBusy: z.number().min(0).max(1),
  resultChars: count,
  estTokens: count,
  avgMs: z.number().nonnegative().optional(),
  p95Ms: z.number().nonnegative().optional(),
  topLabels: z.array(z.object({ label: activityLabelSchema, count: count })),
}) satisfies z.ZodType<ActivityStationInsight>;

export const activityInsightsSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: providerIdSchema.optional(),
  sessionId: z.string().max(256).optional(),
  span: z.object({
    startAt: time.optional(),
    endAt: time.optional(),
    activeMs: z.number().nonnegative(),
  }),
  totals: z.object({
    prompts: count,
    turns: count,
    steps: count,
    calls: count,
    errors: count,
    denials: count,
    cancelled: count,
    asks: count,
    resultChars: count,
    hookRuns: count,
    hookMs: z.number().nonnegative(),
    pushed: count,
    compactions: count,
    subagents: count,
  }),
  stations: z.array(activityStationInsightSchema),
  transitions: z.object({
    stations: z.array(activityStationIdSchema),
    counts: z.array(z.array(count)),
  }),
  patterns: z.array(activityPatternSchema),
  models: z.array(
    z.object({ model: z.string().max(128), steps: count, firstAt: time, lastAt: time }),
  ),
  slowest: z.array(
    z.object({
      station: activityStationIdSchema,
      label: activityLabelSchema,
      durationMs: z.number().nonnegative(),
      at: time,
    }),
  ),
}) satisfies z.ZodType<ActivityInsights>;

export const activityExportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('sidekick-activity'),
  providerId: providerIdSchema.optional(),
  sessionId: z.string().max(256).optional(),
  at: time,
  snapshot: activitySnapshotSchema,
  insights: activityInsightsSchema,
  records: z.array(activityRecordSchema).optional(),
}) satisfies z.ZodType<ActivityExport>;
