/**
 * One Codex usage object, read four ways: the rollout parser, the raw-usage
 * pricer, prompt history, and the headless `exec --json` parser. Every path
 * must split it into the same disjoint buckets and price it the same.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexRolloutParser } from './parsers/codexParser';
import { collectPromptHistory } from './promptHistory';
import { parseCodexExecEvent } from './headless/codexExecJson';
import { calculateNormalizedUsageCost, priceProviderUsage } from './usageNormalization';
import { getModelPricing } from './modelInfo';
import { createSessionLogFixtures, writeJsonl, ts } from './testing/sessionLogFixtures';

const MODEL = 'gpt-6.1-sol';
// Codex counts cache reads and writes inside input_tokens.
const USAGE = {
  input_tokens: 10_000,
  cached_input_tokens: 6_000,
  cache_write_input_tokens: 1_500,
  output_tokens: 900,
  reasoning_output_tokens: 300,
  total_tokens: 10_900,
};
const BUCKETS = { inputTokens: 2_500, cacheReadTokens: 6_000, cacheWriteTokens: 1_500 };

let home: string;
let repo: string;
const { codexFile, codexMeta, codexUser } = createSessionLogFixtures(() => ({ home, repo }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-writes-'));
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Codex cache writes', () => {
  it('splits into the same buckets and prices the same on every path', async () => {
    // 1. The rollout parser.
    const parser = new CodexRolloutParser();
    parser.convertLine({
      timestamp: ts(1),
      type: 'turn_context',
      payload: { cwd: repo, model: MODEL },
    } as never);
    const [event] = parser.convertLine({
      timestamp: ts(2),
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: USAGE } },
    } as never);
    const parsed = event.message!.normalizedUsage!;
    expect({
      inputTokens: parsed.uncachedInputTokens,
      cacheReadTokens: parsed.cacheReadTokens,
      cacheWriteTokens: parsed.cacheWriteTokens,
    }).toEqual(BUCKETS);
    expect(event.message!.usage).toMatchObject({
      input_tokens: BUCKETS.inputTokens,
      cache_read_input_tokens: BUCKETS.cacheReadTokens,
      cache_creation_input_tokens: BUCKETS.cacheWriteTokens,
    });

    // 2. The raw-usage pricer.
    const raw = priceProviderUsage({ provider: 'codex', usage: USAGE, model: MODEL });
    expect({
      inputTokens: raw.normalized.uncachedInputTokens,
      cacheReadTokens: raw.normalized.cacheReadTokens,
      cacheWriteTokens: raw.normalized.cacheWriteTokens,
    }).toEqual(BUCKETS);

    // 3. Prompt history.
    const file = codexFile();
    writeJsonl(file, [
      codexMeta(repo),
      { timestamp: ts(1), type: 'turn_context', payload: { cwd: repo, model: MODEL } },
      codexUser(['price this'], 2),
      {
        timestamp: ts(3),
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: USAGE } },
      },
    ]);
    const history = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      homes: { codexHomes: [path.join(home, '.codex')], claudeHomes: [] },
    });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].usage).toEqual({ ...BUCKETS, outputTokens: 900 });

    // 4. The headless `codex exec --json` parser.
    const usageEvent = parseCodexExecEvent(
      { type: 'turn.completed', usage: USAGE },
      { model: MODEL },
    ).find((e) => e.type === 'usage');
    expect(usageEvent?.type === 'usage' ? usageEvent.usage : undefined).toMatchObject(BUCKETS);

    // Same dollars: the parser's event, the raw pricer, and the catalog rates.
    const pricing = getModelPricing(MODEL)!;
    expect(pricing.cacheWriteCostPerMillion).toBeGreaterThan(pricing.inputCostPerMillion);
    const expected =
      (BUCKETS.inputTokens * pricing.inputCostPerMillion +
        BUCKETS.cacheReadTokens * pricing.cacheReadCostPerMillion +
        BUCKETS.cacheWriteTokens * pricing.cacheWriteCostPerMillion +
        900 * pricing.outputCostPerMillion) /
      1_000_000;
    expect(raw.costUsd).toBeCloseTo(expected, 12);
    expect(calculateNormalizedUsageCost({ usage: parsed }).costUsd).toBeCloseTo(expected, 12);
  });

  it('keeps an older total-only delta without cache writes in its old shape', () => {
    const parser = new CodexRolloutParser();
    const first = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
    const second = { input_tokens: 250, cached_input_tokens: 100, output_tokens: 30 };
    parser.convertLine({
      timestamp: ts(1),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: first } },
    } as never);
    const [event] = parser.convertLine({
      timestamp: ts(2),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: second } },
    } as never);
    expect(event.message!.normalizedUsage).toMatchObject({
      uncachedInputTokens: 90,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      outputTokens: 20,
    });
  });

  it('subtracts cache writes from a total-only delta too', () => {
    const parser = new CodexRolloutParser();
    const first = {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
      output_tokens: 10,
    };
    const second = {
      input_tokens: 250,
      cached_input_tokens: 100,
      cache_write_input_tokens: 40,
      output_tokens: 30,
    };
    parser.convertLine({
      timestamp: ts(1),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: first } },
    } as never);
    const [event] = parser.convertLine({
      timestamp: ts(2),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: second } },
    } as never);
    // Delta: input 150, cached 60, written 30 → uncached 60.
    expect(event.message!.normalizedUsage).toMatchObject({
      uncachedInputTokens: 60,
      cacheReadTokens: 60,
      cacheWriteTokens: 30,
      outputTokens: 20,
    });
  });

  it('round-trips cache writes through the parser resume state', () => {
    const parser = new CodexRolloutParser();
    parser.convertLine({
      timestamp: ts(1),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: USAGE, total_token_usage: USAGE },
      },
    } as never);
    const state = JSON.parse(JSON.stringify(parser.exportResumeState()));
    const resumed = new CodexRolloutParser();
    expect(resumed.importResumeState(state)).toBe(true);
    expect(resumed.getLastTokenUsage()).toMatchObject({ cache_write_input_tokens: 1_500 });
  });
});
