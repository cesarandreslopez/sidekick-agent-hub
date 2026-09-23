import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventAggregator } from './aggregation/EventAggregator';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { scanSubagentDir } from './parsers/subagentScanner';
import { collectSessionTokenTotals, combineSessionTokenTotals } from './sessionTokenTotals';

const MODEL = 'claude-opus-4-6';

function assistantLine(
  id: string,
  timestamp: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  model = MODEL,
) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id,
      role: 'assistant',
      model,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  };
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

describe('Claude session token totals', () => {
  let dir: string;
  let sessionPath: string;
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sidekick-session-tokens-'));
    sessionPath = path.join(dir, 'sess-1.jsonl');
    provider = new ClaudeCodeProvider();
    writeJsonl(sessionPath, [
      {
        type: 'user',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      },
      // One response split across three lines: partial output, repeat, final output.
      assistantLine('msg_a', '2026-09-01T00:00:01.000Z', {
        input: 10,
        output: 1,
        cacheRead: 1000,
        cacheWrite: 200,
      }),
      assistantLine('msg_a', '2026-09-01T00:00:01.000Z', {
        input: 10,
        output: 1,
        cacheRead: 1000,
        cacheWrite: 200,
      }),
      assistantLine('msg_a', '2026-09-01T00:00:02.000Z', {
        input: 10,
        output: 90,
        cacheRead: 1000,
        cacheWrite: 200,
      }),
      assistantLine('msg_b', '2026-09-01T00:00:03.000Z', { input: 5, output: 20, cacheRead: 1300 }),
      assistantLine('msg_syn', '2026-09-01T00:00:04.000Z', { input: 0, output: 0 }, '<synthetic>'),
    ]);
    writeJsonl(path.join(dir, 'sess-1', 'subagents', 'agent-x1.jsonl'), [
      assistantLine('msg_s1', '2026-09-01T00:00:05.000Z', { input: 2, output: 1, cacheRead: 400 }),
      assistantLine('msg_s1', '2026-09-01T00:00:05.000Z', { input: 2, output: 30, cacheRead: 400 }),
    ]);
    writeFileSync(
      path.join(dir, 'sess-1', 'subagents', 'agent-x1.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Map the code' }),
    );
  });

  afterEach(() => {
    provider.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // msg_a last copy: 10 + 1000 + 200 + 90 = 1300; msg_b: 5 + 1300 + 20 = 1325.
  const MAIN_TOTAL = 1300 + 1325;
  // msg_s1 last copy: 2 + 400 + 30 = 432.
  const SUBAGENT_TOTAL = 432;

  it('reads each response once, last copy wins, through the provider reader', () => {
    const aggregator = new EventAggregator({ providerId: 'claude-code' });
    for (const event of provider.createReader(sessionPath).readAll())
      aggregator.processEvent(event);
    const metrics = aggregator.getMetrics();
    expect(metrics.tokens.totalTokens).toBe(MAIN_TOTAL);
    expect(metrics.tokens.outputTokens).toBe(110);
    // Two real calls; the correction and the synthetic line add none.
    expect(metrics.modelStats.map((m) => [m.model, m.calls])).toEqual([[MODEL, 2]]);
    // The zero-usage <synthetic> line no longer looks like a compaction.
    expect(metrics.compactionCount).toBe(0);
  });

  it('scans subagent transcripts with all four buckets and their meta file', () => {
    const [agent] = scanSubagentDir(dir, 'sess-1');
    expect(agent).toMatchObject({
      agentId: 'x1',
      agentType: 'Explore',
      description: 'Map the code',
      inputTokens: 2,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      totalTokens: SUBAGENT_TOTAL,
    });
  });

  it('combines main thread and subagents', () => {
    const totals = collectSessionTokenTotals(provider, sessionPath);
    expect(totals.mainThread.total).toBe(MAIN_TOTAL);
    expect(totals.subagents).toHaveLength(1);
    expect(totals.subagents[0]).toMatchObject({ agentId: 'x1', agentType: 'Explore' });
    expect(totals.subagentTotal.total).toBe(SUBAGENT_TOTAL);
    expect(totals.combined.total).toBe(MAIN_TOTAL + SUBAGENT_TOTAL);
    expect(totals.combined.cacheRead).toBe(1000 + 1300 + 400);
  });

  it('reuses an already-aggregated main thread', () => {
    const totals = collectSessionTokenTotals(provider, sessionPath, {
      mainThread: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect(totals.mainThread.total).toBe(2);
    expect(totals.combined.total).toBe(2 + SUBAGENT_TOTAL);
  });
});

describe('combineSessionTokenTotals', () => {
  it('keeps a provider-aware main total that includes separately billed reasoning', () => {
    const totals = combineSessionTokenTotals(
      { inputTokens: 10, outputTokens: 10, reasoningTokens: 5, totalTokens: 25 },
      [{ agentId: 'a', toolCalls: [], inputTokens: 1, outputTokens: 1, totalTokens: 2 }],
    );
    expect(totals.mainThread.billedOutsideBuckets).toBe(5);
    expect(totals.combined.total).toBe(27);
  });

  it('falls back to input + output for subagent stats from older scanners', () => {
    const totals = combineSessionTokenTotals({ inputTokens: 1, outputTokens: 1 }, [
      { agentId: 'legacy', toolCalls: [], inputTokens: 3, outputTokens: 4 },
    ]);
    expect(totals.subagentTotal.total).toBe(7);
    expect(totals.combined.total).toBe(9);
  });
});
