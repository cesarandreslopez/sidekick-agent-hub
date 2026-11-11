/**
 * Hand-written activity records for the CLI's activity tests, folded through
 * the real shared reducer. Test-only (imported from `*.test.ts` files).
 */

import {
  applyActivityRecords,
  createActivityState,
  snapshotActivity,
  summarizeActivity,
} from 'sidekick-shared';
import type { ActivityInsights, ActivityRecord, ActivitySnapshot } from 'sidekick-shared';

export const T0 = Date.parse('2026-11-10T22:00:00Z');

/** A short session: a prompt, reads, a failing then passing test run, a fetch, one call still open. */
export function sampleRecords(): ActivityRecord[] {
  let seq = 0;
  const at = (s: number) => T0 + s * 1_000;
  const r = <T extends Omit<ActivityRecord, 'seq'>>(record: T) =>
    ({ ...record, seq: seq++ }) as unknown as ActivityRecord;
  return [
    r({ kind: 'session', at: at(0), providerId: 'claude-code', sessionId: 'sess-cli' }),
    r({ kind: 'prompt', at: at(1) }),
    r({ kind: 'step', at: at(3), model: 'claude-opus-5-5' }),
    r({
      kind: 'toolStart',
      at: at(4),
      id: 't1',
      station: 'files',
      label: 'src/{index}.ts',
      tool: 'Read',
      hint: 'read',
    }),
    r({
      kind: 'toolEnd',
      at: at(4.2),
      id: 't1',
      outcome: 'ok',
      durationMs: 200,
      resultChars: 4_000,
    }),
    r({
      kind: 'toolStart',
      at: at(5),
      id: 't2',
      station: 'shell',
      label: 'npm test',
      tool: 'Bash',
      hint: 'test',
    }),
    r({
      kind: 'toolEnd',
      at: at(9),
      id: 't2',
      outcome: 'error',
      durationMs: 4_000,
      resultChars: 2_000,
    }),
    r({
      kind: 'toolStart',
      at: at(10),
      id: 't3',
      station: 'files',
      label: 'src/app.ts',
      tool: 'Edit',
      hint: 'edit',
    }),
    r({ kind: 'toolEnd', at: at(10.1), id: 't3', outcome: 'ok', durationMs: 100 }),
    r({
      kind: 'toolStart',
      at: at(11),
      id: 't4',
      station: 'shell',
      label: 'npm test',
      tool: 'Bash',
      hint: 'test',
    }),
    r({
      kind: 'toolEnd',
      at: at(15),
      id: 't4',
      outcome: 'ok',
      durationMs: 4_000,
      resultChars: 1_500,
    }),
    r({
      kind: 'toolStart',
      at: at(16),
      id: 't5',
      station: 'network',
      label: 'example.com',
      tool: 'WebFetch',
    }),
    r({
      kind: 'context',
      at: at(17),
      percent: 42,
      tokens: 84_000,
      window: 200_000,
      source: 'usage',
    }),
  ];
}

export function sampleActivity(): {
  records: ActivityRecord[];
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
} {
  const records = sampleRecords();
  const state = createActivityState({ providerId: 'claude-code', sessionId: 'sess-cli' });
  applyActivityRecords(state, records);
  return { records, snapshot: snapshotActivity(state), insights: summarizeActivity(state) };
}
