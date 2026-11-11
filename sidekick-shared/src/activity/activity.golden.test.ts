/**
 * Golden output, privacy, cross-provider parity and performance for the
 * activity core, on the hand-synthesized fixtures in `fixtures/activity/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayActivity } from '../activityReplay';
import { CodexRolloutParser } from '../parsers/codexParser';
import { convertOpenCodeMessage } from '../parsers/openCodeParser';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import type { SessionProviderBase, SessionReader } from '../providers/types';
import {
  activityExportSchema,
  activityInsightsSchema,
  activityRecordSchema,
  activitySnapshotSchema,
} from '../schemas/activity';
import { extractSessionEvents } from '../schemas/sessionEvent';
import type { OpenCodeMessage, OpenCodePart } from '../types/opencode';
import type { SessionEvent } from '../types/sessionEvent';
import { summarizeActivity } from './insights';
import { createActivityRecorder } from './recorder';
import { applyActivityRecords, createActivityState, snapshotActivity } from './state';
import { createActivityTimeline, exportActivity, normalizeActivityRecords } from './timeline';
import type { ActivityLabelMode, ActivityRecord } from './types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'activity');
const golden = path.join(fixtures, '__golden__');
const claudeSession = path.join(fixtures, 'claude-code', 'sess-activity.jsonl');
const codexParent = path.join(fixtures, 'codex', 'rollout-activity-parent.jsonl');
const codexChild = path.join(fixtures, 'codex', 'rollout-activity-child.jsonl');

function codexLines(file: string): SessionEvent[] {
  const parser = new CodexRolloutParser({
    includeTurnLifecycle: true,
    includeSubagentActivity: true,
  });
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => parser.convertLine(JSON.parse(line)));
}

/** A Codex provider over the fixture rollouts: one parent, one child. */
function codexFixtureProvider(): SessionProviderBase {
  const reader = (file: string): SessionReader => {
    const events = codexLines(file);
    return {
      readNew: () => events,
      readAll: () => events,
      reset: () => undefined,
      exists: () => true,
      flush: () => undefined,
      getPosition: () => 0,
      seekTo: () => undefined,
      wasTruncated: () => false,
    };
  };
  return {
    id: 'codex',
    getSessionId: (sessionPath: string) => path.basename(sessionPath, '.jsonl'),
    createReader: (sessionPath: string) => reader(sessionPath),
    scanSubagents: () => [
      {
        agentId: '01a1a000-0000-7000-8000-00000000a002',
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        filePath: codexChild,
        spawnToolUseId: 'call_9',
      },
    ],
  } as unknown as SessionProviderBase;
}

function claudeReplay(labels?: ActivityLabelMode) {
  return replayActivity({ provider: new ClaudeCodeProvider(), sessionPath: claudeSession, labels });
}

function codexReplay(labels?: ActivityLabelMode) {
  return replayActivity({ provider: codexFixtureProvider(), sessionPath: codexParent, labels });
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('golden output', () => {
  it('Claude Code: records, snapshot and insights', async () => {
    const replay = claudeReplay();
    await expect(pretty(replay.records)).toMatchFileSnapshot(
      path.join(golden, 'claude-records.json.snap'),
    );
    await expect(pretty(replay.snapshot)).toMatchFileSnapshot(
      path.join(golden, 'claude-snapshot.json.snap'),
    );
    await expect(pretty(replay.insights)).toMatchFileSnapshot(
      path.join(golden, 'claude-insights.json.snap'),
    );
    expect(replay.subagents).toEqual([
      { agentId: 'a1b2c3d4', spawnId: 'toolu_16', events: 6, dropped: 0 },
    ]);
  });

  it('Codex: records, snapshot and insights, with the child rollout merged', async () => {
    const replay = codexReplay();
    await expect(pretty(replay.records)).toMatchFileSnapshot(
      path.join(golden, 'codex-records.json.snap'),
    );
    await expect(pretty(replay.snapshot)).toMatchFileSnapshot(
      path.join(golden, 'codex-snapshot.json.snap'),
    );
    await expect(pretty(replay.insights)).toMatchFileSnapshot(
      path.join(golden, 'codex-insights.json.snap'),
    );
    // The child's command is attributed to the spawn call.
    expect(
      replay.records.some(
        (record) =>
          record.kind === 'toolStart' && record.agentId === 'call_9' && record.id === 'call_c1',
      ),
    ).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(claudeReplay().records)).toBe(JSON.stringify(claudeReplay().records));
  });

  it('validates against the wire schemas', () => {
    for (const replay of [claudeReplay(), codexReplay()]) {
      for (const record of replay.records) activityRecordSchema.parse(record);
      activitySnapshotSchema.parse(replay.snapshot);
      activityInsightsSchema.parse(replay.insights);
      activityExportSchema.parse(
        exportActivity({
          snapshot: replay.snapshot,
          insights: replay.insights,
          records: replay.records,
        }),
      );
    }
  });
});

describe('privacy: names, never content', () => {
  for (const labels of ['names', 'none'] as const) {
    it(`no content reaches records, snapshots or insights in ${labels} mode`, () => {
      for (const replay of [claudeReplay(labels), codexReplay(labels)]) {
        const output = JSON.stringify([replay.records, replay.snapshot, replay.insights]);
        expect(output).not.toContain('SKCANARY');
      }
    });
  }

  it('in descriptive mode, only the model’s descriptions may show', () => {
    const replay = claudeReplay('descriptive');
    const labels = replay.records
      .map((record) => ('label' in record ? record.label : ''))
      .filter((label) => label.includes('SKCANARY'));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect([
        'Run the unit tests SKCANARY-desc',
        'Find SKCANARY usages',
        'Fetch SKCANARY',
        'Background SKCANARY',
        'PreToolUse · Edit · guard-SKCANARY',
      ]).toContain(label);
    }
  });

  it('labels in none mode come from the vocabulary only (no server or file names)', () => {
    const replay = claudeReplay('none');
    const labels = new Set(
      replay.records.flatMap((record) => ('label' in record ? [record.label] : [])),
    );
    for (const label of labels) {
      expect(label).not.toMatch(/\.ts|\.md|example|chrome|memory\//);
    }
  });
});

// ── Cross-provider parity ────────────────────────────────────────────────

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** The same scenario in each provider's log: prompt → read → edit → test fails → test passes → fetch → done. */
function claudeScenario(): SessionEvent[] {
  const lines: unknown[] = [];
  const common = { entrypoint: 'cli', sessionId: 'p' };
  const call = (sec: number, id: string, name: string, input: Record<string, unknown>) =>
    lines.push({
      type: 'assistant',
      ...common,
      timestamp: iso(sec),
      message: {
        id: `m-${id}`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id, name, input }],
        stop_reason: 'tool_use',
      },
    });
  const result = (sec: number, id: string, isError = false) =>
    lines.push({
      type: 'user',
      ...common,
      timestamp: iso(sec),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'out',
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    });
  lines.push({
    type: 'user',
    ...common,
    timestamp: iso(0),
    message: { role: 'user', content: 'go' },
  });
  call(1, 'r', 'Read', { file_path: '/w/src/a.ts' });
  result(2, 'r');
  call(3, 'e', 'Edit', { file_path: '/w/src/a.ts' });
  result(4, 'e');
  call(5, 't1', 'Bash', { command: 'npm test' });
  result(6, 't1', true);
  call(7, 't2', 'Bash', { command: 'npm test' });
  result(8, 't2');
  call(9, 'f', 'WebFetch', { url: 'https://docs.example.com/x' });
  result(10, 'f');
  lines.push({
    type: 'assistant',
    ...common,
    timestamp: iso(11),
    message: {
      id: 'm-end',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    },
  });
  return lines.flatMap((line) => extractSessionEvents(line));
}

function codexScenario(): SessionEvent[] {
  const rows: unknown[] = [];
  const row = (sec: number, type: string, payload: Record<string, unknown>) =>
    rows.push({ timestamp: iso(sec), type, payload });
  const call = (sec: number, id: string, name: string, args: Record<string, unknown>) =>
    row(sec, 'response_item', {
      type: 'function_call',
      id: `fc_${id}`,
      name,
      arguments: JSON.stringify(args),
      call_id: id,
    });
  const out = (sec: number, id: string, text: string) =>
    row(sec, 'response_item', { type: 'function_call_output', call_id: id, output: text });
  row(0, 'turn_context', { model: 'gpt-6.1-sol' });
  row(0, 'event_msg', { type: 'task_started', turn_id: 't' });
  row(0, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'go' }],
  });
  call(1, 'r', 'view_image', { path: '/w/src/a.ts' });
  out(2, 'r', 'ok');
  row(3, 'response_item', {
    type: 'custom_tool_call',
    call_id: 'e',
    name: 'apply_patch',
    input: '*** Update File: /w/src/a.ts\n',
  });
  row(4, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: 'e',
    output: '{"metadata":{"exit_code":0}}',
  });
  call(5, 't1', 'exec_command', { cmd: 'npm test' });
  out(6, 't1', 'Process exited with code 1');
  call(7, 't2', 'exec_command', { cmd: 'npm test' });
  out(8, 't2', 'Process exited with code 0');
  call(9, 'f', 'web_search', { query: 'x' });
  out(10, 'f', 'ok');
  row(11, 'event_msg', { type: 'task_complete', turn_id: 't' });
  const parser = new CodexRolloutParser({ includeTurnLifecycle: true });
  return rows.flatMap((line) => parser.convertLine(line as never));
}

function openCodeScenario(): SessionEvent[] {
  const message = (id: string, role: 'user' | 'assistant', sec: number): OpenCodeMessage => ({
    id,
    sessionID: 's',
    role,
    modelID: 'claude-opus-5-5',
    tokens: { input: 0, output: 0 },
    time: { created: T0 + sec * 1000, completed: T0 + sec * 1000 },
  });
  const tool = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    sec: number,
    status: 'completed' | 'error',
  ): OpenCodePart =>
    ({
      id: `p-${id}`,
      sessionID: 's',
      messageID: `m-${id}`,
      type: 'tool',
      callID: id,
      tool: name,
      state: {
        status,
        input,
        ...(status === 'error' ? { error: 'failed' } : { output: 'out' }),
        time: { start: T0 + sec * 1000, end: T0 + (sec + 1) * 1000 },
      },
    }) as unknown as OpenCodePart;
  const events: SessionEvent[] = [];
  events.push(
    ...convertOpenCodeMessage(message('u', 'user', 0), [
      {
        id: 'pu',
        sessionID: 's',
        messageID: 'u',
        type: 'text',
        text: 'go',
      } as unknown as OpenCodePart,
    ]),
  );
  const steps: Array<[string, string, Record<string, unknown>, number, 'completed' | 'error']> = [
    ['r', 'read', { filePath: '/w/src/a.ts' }, 1, 'completed'],
    ['e', 'edit', { filePath: '/w/src/a.ts' }, 3, 'completed'],
    ['t1', 'bash', { command: 'npm test' }, 5, 'error'],
    ['t2', 'bash', { command: 'npm test' }, 7, 'completed'],
    ['f', 'webfetch', { url: 'https://docs.example.com/x' }, 9, 'completed'],
  ];
  for (const [id, name, input, sec, status] of steps) {
    events.push(
      ...convertOpenCodeMessage(message(`m-${id}`, 'assistant', sec + 1), [
        tool(id, name, input, sec, status),
      ]),
    );
  }
  return events;
}

describe('cross-provider parity', () => {
  it('the same scenario gives the same stations, outcomes and route in every provider', () => {
    const shape = (providerId: 'claude-code' | 'codex' | 'opencode', events: SessionEvent[]) => {
      const records = normalizeActivityRecords(
        createActivityRecorder({ providerId }).observeMany(events),
      );
      const state = createActivityState();
      applyActivityRecords(state, records);
      const snapshot = snapshotActivity(state);
      const insights = summarizeActivity(state);
      return {
        calls: records
          .filter(
            (record): record is Extract<ActivityRecord, { kind: 'toolStart' }> =>
              record.kind === 'toolStart',
          )
          .map((record) => record.station),
        outcomes: records
          .filter(
            (record): record is Extract<ActivityRecord, { kind: 'toolEnd' }> =>
              record.kind === 'toolEnd',
          )
          .map((record) => record.outcome),
        route: snapshot.route.map((stop) => stop.station),
        prompts: snapshot.totals.prompts,
        perStation: Object.fromEntries(
          insights.stations.filter((s) => s.calls > 0).map((s) => [s.id, [s.calls, s.errors]]),
        ),
      };
    };
    const claude = shape('claude-code', claudeScenario());
    expect(claude).toEqual({
      calls: ['files', 'files', 'shell', 'shell', 'network'],
      outcomes: ['ok', 'ok', 'error', 'ok', 'ok'],
      route: ['files', 'shell', 'network'],
      prompts: 1,
      perStation: { files: [2, 0], shell: [2, 1], network: [1, 0] },
    });
    expect(shape('codex', codexScenario())).toEqual(claude);
    expect(shape('opencode', openCodeScenario())).toEqual(claude);
  });
});

describe('performance', () => {
  it('records and scrubs 20k events quickly', () => {
    const events: SessionEvent[] = [];
    for (let index = 0; index < 10_000; index++) {
      const id = `t${index}`;
      const at = T0 + index * 1000;
      events.push({
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        message: {
          role: 'assistant',
          id: `m${index}`,
          model: 'claude-opus-5-5',
          content: [
            {
              type: 'tool_use',
              id,
              name: index % 3 === 0 ? 'Bash' : 'Read',
              input: { command: 'npm test', file_path: '/w/a.ts' },
            },
          ],
        },
      });
      events.push({
        type: 'user',
        timestamp: new Date(at + 500).toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: 'x'.repeat(100),
              is_error: index % 7 === 0,
            },
          ],
        },
      });
    }
    const started = performance.now();
    const records = createActivityRecorder({ providerId: 'claude-code' }).observeMany(events);
    const timeline = createActivityTimeline(records);
    const built = performance.now() - started;
    const scrubStart = performance.now();
    for (let run = 0; run < 50; run++) timeline.snapshotAt(T0 + run * 200_000);
    const perScrub = (performance.now() - scrubStart) / 50;
    // Generous bounds for CI machines; typical is a fraction of these.
    expect(built).toBeLessThan(3000);
    expect(perScrub).toBeLessThan(50);
  });
});
