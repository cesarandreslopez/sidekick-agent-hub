/**
 * Hand-built activity snapshots and insights for renderer tests.
 *
 * Test support only: the `.setup.ts` suffix keeps this file out of the
 * build and out of type-aware lint. Every scene is pinned to {@link NOW}, so
 * renderers produce the same bytes on every run.
 */

import { ACTIVITY_STATIONS } from '../activity/stations';
import type { ActivityStationId } from '../activity/stations';
import type {
  ActivityEntry,
  ActivityInsights,
  ActivitySnapshot,
  ActivityStationInsight,
  ActivityStationSnapshot,
} from '../activity/types';

/** 2026-11-11T12:00:00Z. */
export const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

function stationsFrom(
  partial: Partial<Record<ActivityStationId, Omit<ActivityStationSnapshot, 'id'>>>,
): ActivityStationSnapshot[] {
  return ACTIVITY_STATIONS.map((id) => ({
    id,
    count: 0,
    running: 0,
    faults: 0,
    ...partial[id],
  }));
}

function entry(
  key: string,
  station: ActivityStationId,
  label: string,
  startedAgo: number,
  endedAgo?: number,
  extra: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    key,
    station,
    label,
    from: 'core',
    startedAt: NOW - startedAgo,
    ...(endedAgo !== undefined ? { endedAt: NOW - endedAgo, outcome: 'ok' as const } : {}),
    ...extra,
  };
}

/** Mid-turn, many things at once. */
export function busySnapshot(): ActivitySnapshot {
  const running: ActivityEntry[] = [
    entry('t-shell-long', 'shell', 'npm test', 75_000, undefined, { tool: 'Bash', hint: 'test' }),
    entry('t-shell-vitest', 'shell', 'vitest run', 600, undefined, { tool: 'Bash', hint: 'test' }),
    entry('t-edit', 'files', 'activity/types.ts', 200, undefined, { tool: 'Edit', hint: 'edit' }),
    entry('t-agent', 'agents', 'explore the parser', 40_000, undefined, { tool: 'Agent' }),
  ];
  const entries: ActivityEntry[] = [
    entry('p-1', 'you', 'new message', 60_000, 60_000, {
      from: 'inbound',
      labelKey: 'newMessage',
      mark: 'prompt',
    }),
    entry('t-read-1', 'files', 'src/index.ts', 50_000, 49_900, { tool: 'Read', hint: 'read' }),
    entry('t-read-2', 'files', 'src/browser.ts', 49_800, 49_750, { tool: 'Read', hint: 'read' }),
    entry('t-grep', 'files', 'Grep', 49_700, 49_650, { tool: 'Grep', hint: 'search' }),
    running[0],
    entry('t-fetch', 'network', 'registry.npmjs.org', 9_000, 8_000, {
      tool: 'WebFetch',
      outcome: 'denied',
      deniedBy: 'user',
    }),
    entry('t-read-3', 'files', 'activity/state.ts', 5_000, 4_800, { tool: 'Read', hint: 'read' }),
    entry('t-test-fail', 'shell', 'npm test', 3_000, 2_500, {
      tool: 'Bash',
      hint: 'test',
      outcome: 'error',
    }),
    entry('s-switch', 'model', 'sonnet 5.5 → opus 5.5', 3_000, 3_000, {
      labelKey: undefined,
      mark: 'switch',
    }),
    entry('s-1', 'model', 'model step', 2_000, 300, { labelKey: 'modelStep' }),
    entry('m-push', 'memory', 'CLAUDE.md', 1_500, 1_500, {
      from: 'inbound',
      mark: 'pushed',
    }),
    running[3],
    entry('a1-read', 'files', 'parsers/codexParser.ts', 700, 500, {
      from: 'agents',
      agentId: 'a1',
      tool: 'Read',
      hint: 'read',
    }),
    running[1],
    running[2],
  ];
  return {
    schemaVersion: 1,
    providerId: 'claude-code',
    sessionId: 'fixture-busy',
    at: NOW - 200,
    startedAt: NOW - 600_000,
    stations: stationsFrom({
      you: { count: 3, running: 0, faults: 0, lastAt: NOW - 60_000 },
      model: { count: 18, running: 0, faults: 0, lastAt: NOW - 300 },
      memory: { count: 5, running: 0, faults: 0, lastAt: NOW - 1_500, pushed: 2 },
      files: { count: 42, running: 1, runningSince: NOW - 200, faults: 0, lastAt: NOW - 200 },
      shell: {
        count: 27,
        running: 2,
        runningSince: NOW - 75_000,
        faults: 3,
        lastAt: NOW - 600,
        lastFaultAt: NOW - 2_500,
      },
      network: { count: 6, running: 0, faults: 1, lastAt: NOW - 8_000, lastFaultAt: NOW - 8_000 },
      agents: { count: 2, running: 1, runningSince: NOW - 40_000, faults: 0, lastAt: NOW - 500 },
      skills: { count: 1, running: 0, faults: 0, lastAt: NOW - 400_000 },
      hooks: { count: 4, running: 0, faults: 0, lastAt: NOW - 30_000 },
      plan: { count: 3, running: 0, faults: 0, lastAt: NOW - 120_000 },
    }),
    entries,
    running,
    agents: [{ agentId: 'a1', label: 'explore the parser', startedAt: NOW - 40_000 }],
    route: [
      { station: 'you', at: NOW - 60_000 },
      { station: 'files', at: NOW - 50_000 },
      { station: 'shell', at: NOW - 45_000 },
      { station: 'network', at: NOW - 9_000 },
      { station: 'files', at: NOW - 5_000 },
      { station: 'shell', at: NOW - 3_000 },
      { station: 'files', at: NOW - 200 },
    ],
    model: {
      id: 'claude-opus-5-5',
      steps: 18,
      switchedAt: NOW - 3_000,
      previous: 'claude-sonnet-5-5',
    },
    context: { percent: 74, tokens: 740_000, window: 1_000_000, at: NOW - 300, source: 'usage' },
    compactions: 1,
    lastCompactionAt: NOW - 700,
    turn: { working: true, since: NOW - 60_000, lastPromptAt: NOW - 60_000 },
    patterns: [
      {
        kind: 'retry-streak',
        station: 'shell',
        failures: 3,
        startAt: NOW - 40_000,
        endAt: NOW - 2_500,
        state: 'open',
      },
      {
        kind: 'alternation',
        stations: ['files', 'shell'],
        cycles: 4,
        startAt: NOW - 50_000,
        endAt: NOW - 200,
        state: 'open',
        flavor: 'edit-test',
      },
    ],
    totals: { prompts: 3, calls: 93, errors: 3, denials: 1, steps: 18, pushed: 2 },
  };
}

/** The model is thinking: a turn runs and no main-loop call is open. */
export function thinkingSnapshot(): ActivitySnapshot {
  const base = quietSnapshot();
  return {
    ...base,
    sessionId: 'fixture-thinking',
    turn: {
      working: true,
      since: NOW - 20_000,
      thinkingSince: NOW - 12_000,
      lastPromptAt: NOW - 20_000,
    },
    context: { percent: 93, at: NOW - 12_000, source: 'host' },
  };
}

/** Between turns: the answer just landed. */
export function quietSnapshot(): ActivitySnapshot {
  return {
    schemaVersion: 1,
    providerId: 'codex',
    sessionId: 'fixture-quiet',
    at: NOW - 400,
    startedAt: NOW - 300_000,
    stations: stationsFrom({
      you: { count: 1, running: 0, faults: 0, lastAt: NOW - 300_000 },
      model: { count: 6, running: 0, faults: 0, lastAt: NOW - 400 },
      files: { count: 9, running: 0, faults: 0, lastAt: NOW - 30_000 },
      shell: { count: 4, running: 0, faults: 0, lastAt: NOW - 20_000 },
      plan: { count: 2, running: 0, faults: 0, lastAt: NOW - 60_000 },
    }),
    entries: [
      entry('p-1', 'you', 'new message', 300_000, 300_000, {
        from: 'inbound',
        labelKey: 'newMessage',
        mark: 'prompt',
      }),
      entry('t-plan', 'plan', 'plan update', 60_000, 60_000, {
        labelKey: 'planUpdate',
        tool: 'UpdatePlan',
      }),
      entry('t-read', 'files', 'src/app.ts', 30_000, 29_000, { tool: 'Read' }),
      entry('t-sh', 'shell', 'cargo test', 20_000, 15_000, { tool: 'Bash', hint: 'test' }),
      entry('done', 'you', 'answer ready', 400, 400, { labelKey: 'answerReady', mark: 'done' }),
    ],
    running: [],
    agents: [],
    route: [
      { station: 'you', at: NOW - 300_000 },
      { station: 'plan', at: NOW - 60_000 },
      { station: 'files', at: NOW - 30_000 },
      { station: 'shell', at: NOW - 20_000 },
    ],
    model: { id: 'gpt-6.1-sol', steps: 6 },
    context: { percent: 23, tokens: 212_000, window: 922_000, at: NOW - 400, source: 'usage' },
    compactions: 0,
    turn: {
      working: false,
      lastPromptAt: NOW - 300_000,
      lastEnd: { at: NOW - 400, outcome: 'done' },
    },
    patterns: [],
    totals: { prompts: 1, calls: 22, errors: 0, denials: 0, steps: 6, pushed: 0 },
  };
}

/** Labels written to break things: markup, quotes, controls, bidi, braces. */
export function hostileSnapshot(): ActivitySnapshot {
  const base = busySnapshot();
  const hostile = 'a<b>"c"\'d\'&e\u0000\u0007‮{red-fg}</svg><script>x</script>';
  return {
    ...base,
    entries: base.entries.map((e) => ({ ...e, label: hostile })),
    running: base.running.map((e) => ({ ...e, label: hostile })),
    agents: base.agents.map((a) => ({ ...a, agentId: `${a.agentId}"><x`, label: hostile })),
    model: base.model ? { ...base.model, id: hostile } : undefined,
  };
}

function stationInsight(
  id: ActivityStationId,
  partial: Partial<ActivityStationInsight> = {},
): ActivityStationInsight {
  return {
    id,
    calls: 0,
    errors: 0,
    denials: 0,
    cancelled: 0,
    busyMs: 0,
    callMs: 0,
    shareOfBusy: 0,
    resultChars: 0,
    estTokens: 0,
    topLabels: [],
    ...partial,
  };
}

export function busyInsights(): ActivityInsights {
  const busy: Partial<Record<ActivityStationId, Partial<ActivityStationInsight>>> = {
    files: {
      calls: 42,
      busyMs: 121_000,
      callMs: 130_000,
      shareOfBusy: 0.31,
      resultChars: 49_200,
      estTokens: 12_300,
      avgMs: 3_100,
      p95Ms: 9_000,
      topLabels: [
        { label: 'activity/types.ts', count: 9 },
        { label: 'src/index.ts', count: 4 },
      ],
    },
    shell: {
      calls: 27,
      errors: 3,
      busyMs: 252_000,
      callMs: 310_000,
      shareOfBusy: 0.64,
      resultChars: 32_400,
      estTokens: 8_100,
      avgMs: 11_400,
      p95Ms: 75_000,
      topLabels: [{ label: 'npm test', count: 12 }],
    },
    network: {
      calls: 6,
      denials: 1,
      busyMs: 40_000,
      callMs: 40_000,
      shareOfBusy: 0.1,
      resultChars: 4_000,
      estTokens: 1_000,
    },
    model: { calls: 18 },
    memory: { calls: 5 },
    you: { calls: 3 },
    agents: { calls: 2, busyMs: 40_000, callMs: 40_000, shareOfBusy: 0.1 },
    skills: { calls: 1 },
    hooks: { calls: 4 },
    plan: { calls: 3 },
  };
  const stations = ACTIVITY_STATIONS.map((id) => stationInsight(id, busy[id]));
  const counts = ACTIVITY_STATIONS.map(() => ACTIVITY_STATIONS.map(() => 0));
  counts[3][4] = 11;
  counts[4][3] = 10;
  return {
    schemaVersion: 1,
    providerId: 'claude-code',
    sessionId: 'fixture-busy',
    span: { startAt: NOW - 600_000, endAt: NOW - 200, activeMs: 392_000 },
    totals: {
      prompts: 3,
      turns: 3,
      steps: 18,
      calls: 93,
      errors: 3,
      denials: 1,
      cancelled: 0,
      asks: 2,
      resultChars: 85_600,
      hookRuns: 31,
      hookMs: 4_200,
      pushed: 2,
      compactions: 1,
      subagents: 2,
    },
    stations,
    transitions: { stations: [...ACTIVITY_STATIONS], counts },
    patterns: busySnapshot().patterns,
    models: [
      { model: 'claude-sonnet-5-5', steps: 4, firstAt: NOW - 600_000, lastAt: NOW - 3_100 },
      { model: 'claude-opus-5-5', steps: 14, firstAt: NOW - 3_000, lastAt: NOW - 300 },
    ],
    slowest: [{ station: 'shell', label: 'npm test', durationMs: 75_000, at: NOW - 75_000 }],
  };
}
