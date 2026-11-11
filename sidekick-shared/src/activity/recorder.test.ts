import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexRolloutParser } from '../parsers/codexParser';
import { extractSessionEvents } from '../schemas/sessionEvent';
import type { SessionEvent } from '../types/sessionEvent';
import { createActivityRecorder } from './recorder';
import type { ActivityRecord } from './types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'activity');

function claudeEvents(): SessionEvent[] {
  return fs
    .readFileSync(path.join(fixtures, 'claude-code', 'sess-activity.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) =>
      extractSessionEvents(JSON.parse(line), {
        includeTaskNotifications: true,
        includeActivitySignals: true,
      }),
    );
}

function codexEvents(file = 'rollout-activity-parent.jsonl'): SessionEvent[] {
  const parser = new CodexRolloutParser({
    includeTurnLifecycle: true,
    includeSubagentActivity: true,
  });
  return fs
    .readFileSync(path.join(fixtures, 'codex', file), 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => parser.convertLine(JSON.parse(line)));
}

function kinds(records: ActivityRecord[]): string[] {
  return records.map((record) => record.kind);
}

function find<K extends ActivityRecord['kind']>(
  records: ActivityRecord[],
  kind: K,
  predicate: (record: Extract<ActivityRecord, { kind: K }>) => boolean = () => true,
): Extract<ActivityRecord, { kind: K }> | undefined {
  return records.find(
    (record): record is Extract<ActivityRecord, { kind: K }> =>
      record.kind === kind && predicate(record as Extract<ActivityRecord, { kind: K }>),
  );
}

describe('createActivityRecorder: Claude Code', () => {
  const records = createActivityRecorder({
    providerId: 'claude-code',
    sessionId: 'sess',
  }).observeMany(claudeEvents());

  it('numbers records from 0 without gaps, in non-decreasing time', () => {
    records.forEach((record, index) => expect(record.seq).toBe(index));
    for (let index = 1; index < records.length; index++) {
      expect(records[index].at).toBeGreaterThanOrEqual(records[index - 1].at);
    }
    expect(records[0]).toMatchObject({
      kind: 'session',
      providerId: 'claude-code',
      sessionId: 'sess',
    });
  });

  it('counts one step per assistant message and derives context from usage', () => {
    expect(records.filter((record) => record.kind === 'step')).toHaveLength(19);
    expect(find(records, 'context')).toMatchObject({
      tokens: 21500,
      window: 1_000_000,
      source: 'usage',
    });
  });

  it('records hooks, pushed memory and the prompt', () => {
    expect(find(records, 'hook', (r) => r.hookEvent === 'SessionStart')).toMatchObject({
      outcome: 'context',
      label: 'SessionStart',
    });
    expect(find(records, 'memoryPushed')).toMatchObject({
      label: 'src/CLAUDE.md',
      via: 'attachment',
    });
    expect(records.filter((record) => record.kind === 'prompt')).toHaveLength(2);
  });

  it('classifies the calls and ends them with their outcomes', () => {
    expect(find(records, 'toolStart', (r) => r.id === 'toolu_01')).toMatchObject({
      station: 'memory',
      label: 'memory/notes.md',
    });
    expect(find(records, 'toolEnd', (r) => r.id === 'toolu_03')).toMatchObject({
      outcome: 'error',
    });
    expect(find(records, 'toolEnd', (r) => r.id === 'toolu_14')).toMatchObject({
      outcome: 'denied',
      deniedBy: 'user',
    });
    expect(find(records, 'toolEnd', (r) => r.id === 'toolu_15')).toMatchObject({
      outcome: 'denied',
      deniedBy: 'hook',
    });
    expect(find(records, 'hook', (r) => r.toolUseId === 'toolu_15')).toMatchObject({
      outcome: 'blocked',
    });
  });

  it('starts and ends subagents', () => {
    expect(find(records, 'subagentStart', (r) => r.agentId === 'toolu_16')).toMatchObject({
      label: 'Explore',
    });
    expect(find(records, 'subagentEnd', (r) => r.agentId === 'toolu_16')).toMatchObject({
      outcome: 'ok',
    });
    // The background agent outlives its launch and ends with its notification.
    const launchEnd = find(records, 'toolEnd', (r) => r.id === 'toolu_17');
    const agentEnd = find(records, 'subagentEnd', (r) => r.agentId === 'toolu_17');
    expect(agentEnd!.at).toBeGreaterThan(launchEnd!.at);
  });

  it('ends turns as done and aborted, cancelling the call cut off', () => {
    const ends = records.filter((record) => record.kind === 'turnEnd');
    expect(ends.map((record) => (record as { outcome: string }).outcome)).toEqual([
      'done',
      'aborted',
    ]);
    expect(find(records, 'toolEnd', (r) => r.id === 'toolu_19')).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('records the compaction with its counts', () => {
    expect(find(records, 'compaction')).toMatchObject({
      tokensBefore: 150000,
      tokensAfter: 20000,
      trigger: 'manual',
    });
  });
});

describe('createActivityRecorder: Codex', () => {
  const records = createActivityRecorder({ providerId: 'codex' }).observeMany(codexEvents());

  it('ignores injected context and records the typed prompt', () => {
    expect(records.filter((record) => record.kind === 'prompt')).toHaveLength(2);
  });

  it('ends a call once when Codex writes its result twice', () => {
    expect(
      records.filter((record) => record.kind === 'toolEnd' && record.id === 'call_1'),
    ).toHaveLength(1);
  });

  it('records a declined command as denied by the user', () => {
    expect(find(records, 'toolEnd', (r) => r.id === 'call_2')).toMatchObject({
      outcome: 'denied',
      deniedBy: 'user',
    });
  });

  it('folds a multi-file patch into one call', () => {
    expect(find(records, 'toolStart', (r) => r.id === 'call_3')).toMatchObject({
      station: 'files',
      fold: 3,
      label: 'src/a.ts +2',
    });
    expect(
      records.filter((record) => record.kind === 'toolEnd' && record.id === 'call_3'),
    ).toHaveLength(1);
  });

  it('routes MCP calls, namespaced calls and code cells', () => {
    expect(find(records, 'toolStart', (r) => r.id === 'call_6')).toMatchObject({
      label: 'docs: lookup',
    });
    expect(find(records, 'toolStart', (r) => r.id === 'call_7')).toMatchObject({
      label: 'cua repl: js',
    });
    expect(find(records, 'toolStart', (r) => r.id === 'call_8')).toMatchObject({
      station: 'network',
    });
  });

  it('steps on token counts with the reported context window', () => {
    expect(find(records, 'step')).toMatchObject({ model: 'gpt-6.1-sol' });
    expect(find(records, 'context')).toMatchObject({ window: 400000, tokens: 30000, percent: 7.5 });
  });

  it('follows the subagent lifecycle and the turn boundaries', () => {
    expect(kinds(records)).toContain('subagentStart');
    expect(find(records, 'subagentEnd', (r) => r.agentId === 'call_9')).toBeDefined();
    const ends = records.filter((record) => record.kind === 'turnEnd') as Array<{
      outcome: string;
    }>;
    expect(ends.map((record) => record.outcome)).toEqual(['done', 'aborted']);
    expect(find(records, 'toolEnd', (r) => r.id === 'call_10')).toMatchObject({
      outcome: 'cancelled',
    });
  });
});

describe('createActivityRecorder: state and options', () => {
  it('resumes from export() exactly where an uninterrupted run would be', () => {
    const events = claudeEvents();
    const whole = createActivityRecorder({ providerId: 'claude-code' }).observeMany(events);
    for (const split of [1, 7, 20, 33, events.length - 2]) {
      const first = createActivityRecorder({ providerId: 'claude-code' });
      const head = first.observeMany(events.slice(0, split));
      const state = JSON.parse(JSON.stringify(first.export()));
      const second = createActivityRecorder({ providerId: 'claude-code' });
      expect(second.import(state)).toBe(true);
      const tail = second.observeMany(events.slice(split));
      expect([...head, ...tail]).toEqual(whole);
    }
  });

  it('rejects another provider’s or a malformed state, and resets', () => {
    const recorder = createActivityRecorder({ providerId: 'codex' });
    const claude = createActivityRecorder({ providerId: 'claude-code' });
    claude.observeMany(claudeEvents());
    expect(recorder.import(claude.export())).toBe(false);
    expect(recorder.import({ version: 2 })).toBe(false);
    expect(recorder.nextSeq).toBe(0);
  });

  it('settles open calls and subagents', () => {
    const recorder = createActivityRecorder({ providerId: 'claude-code' });
    recorder.observe({
      type: 'assistant',
      timestamp: '2026-11-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore' } },
        ],
      },
    });
    const settled = recorder.settle(Date.parse('2026-11-01T10:05:00.000Z'), 'cancelled');
    expect(kinds(settled)).toEqual(['toolEnd', 'subagentEnd']);
  });

  it('takes host context observations', () => {
    const recorder = createActivityRecorder({ providerId: 'claude-code', deriveContext: false });
    const records = recorder.observeContext({ at: 1000, percent: 140, tokens: 10, window: 5 });
    expect(records[records.length - 1]).toMatchObject({
      kind: 'context',
      percent: 100,
      source: 'host',
    });
  });

  it('keeps OpenCode starts honest: the end carries the real start', () => {
    const recorder = createActivityRecorder({ providerId: 'opencode' });
    recorder.observe({
      type: 'assistant',
      timestamp: '2026-11-01T10:00:10.000Z',
      message: {
        role: 'assistant',
        id: 'm1',
        content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    const [end] = recorder.observe({
      type: 'user',
      timestamp: '2026-11-01T10:00:08.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok', duration: 3000 }],
      },
    });
    expect(end).toMatchObject({ kind: 'toolEnd', durationMs: 3000 });
    expect((end as { startedAt: number }).startedAt).toBe((end as { at: number }).at - 3000);
  });

  it('upgrades an ended call to denied, never the other way', () => {
    const recorder = createActivityRecorder({ providerId: 'codex' });
    recorder.observe({
      type: 'assistant',
      timestamp: '2026-11-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'm',
        content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
      },
    });
    const result = (isError: boolean, decision?: 'reject'): SessionEvent => ({
      type: 'user',
      timestamp: '2026-11-01T10:00:01.000Z',
      ...(decision ? { permissionDecision: { decision, source: 'user_reject' } } : {}),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: '', is_error: isError }],
      },
    });
    expect(recorder.observe(result(true))).toHaveLength(1);
    expect(recorder.observe(result(true))).toHaveLength(0);
    const upgraded = recorder.observe(result(true, 'reject'));
    expect(upgraded[0]).toMatchObject({ outcome: 'denied' });
    expect(recorder.observe(result(false))).toHaveLength(0);
  });
});
