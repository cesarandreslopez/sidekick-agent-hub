import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

// No Codex state database: rollouts are listed from the sessions directory.
vi.mock('../providers/codexDatabase', async () => {
  const actual = await vi.importActual<typeof import('../providers/codexDatabase')>(
    '../providers/codexDatabase',
  );
  return {
    ...actual,
    CodexDatabase: class {
      isAvailable(): boolean {
        return false;
      }
      open(): boolean {
        return false;
      }
      close(): void {}
    },
  };
});

import { getModelPricing } from '../modelInfo';
import {
  CHILD_ID,
  GRANDCHILD_ID,
  PARENT_ID,
  at,
  childRollout,
  grandchildRollout,
  parentRollout,
} from '../testing/codexSubagentFixtures';
import { collectPromptHistory, type PromptHistoryEntry } from '../promptHistory';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import type { SessionProviderBase } from '../providers/types';
import {
  appendJsonl,
  createSessionLogFixtures,
  ts,
  writeJsonl,
  type Row,
} from '../testing/sessionLogFixtures';
import {
  USAGE_CACHE_VERSION,
  collectUsageEvents,
  getUsageCacheDir,
  pruneUsageCache,
  type UsageEventRecord,
} from './usageEvents';

let repo: string;
let savedCodexHome: string | undefined;
let providers: SessionProviderBase[] = [];

const { claudeFile, claudeUser, claudeAssistant, codexMeta, codexUser } = createSessionLogFixtures(
  () => ({ home: tmpDir, repo }),
);

const CODEX_MODEL = 'gpt-5-codex';

function claude(): ClaudeCodeProvider {
  const provider = new ClaudeCodeProvider();
  providers.push(provider);
  return provider;
}

function codex(): CodexProvider {
  const provider = new CodexProvider();
  providers.push(provider);
  return provider;
}

function codexRollout(id: string, rows: Row[]): string {
  const file = path.join(
    tmpDir,
    '.codex',
    'sessions',
    '2026',
    '09',
    '01',
    `rollout-2026-09-01T10-00-00-${id}.jsonl`,
  );
  writeJsonl(file, rows);
  return file;
}

function codexTurn(second: number, model = CODEX_MODEL): Row {
  return {
    timestamp: ts(second),
    type: 'turn_context',
    payload: { model, cwd: repo },
  };
}

/** A Codex call; totals are cumulative, so each call passes the running total. */
function codexCall(second: number, last: Record<string, number>, total: Record<string, number>) {
  return {
    timestamp: ts(second),
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
  };
}

/** A token count that carries only the running total, as older Codex rollouts write. */
function codexTotalOnly(second: number, total: Record<string, number>): Row {
  return {
    timestamp: ts(second),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total } },
  };
}

const REASONING_CALL = {
  input_tokens: 12_000,
  cached_input_tokens: 4_000,
  output_tokens: 3_000,
  reasoning_output_tokens: 2_000,
};

function cacheFiles(): string[] {
  return fs.readdirSync(getUsageCacheDir()).sort();
}

/** The ordinal each event should carry, from what collectPromptHistory returned. */
function expectedOrdinal(event: UsageEventRecord, prompts: PromptHistoryEntry[]): number | null {
  let best: number | null = null;
  for (const prompt of prompts) {
    if (prompt.sessionId !== event.sessionId || prompt.provider !== event.provider) continue;
    if (Date.parse(prompt.timestamp) > event.timestamp) continue;
    best = best === null ? prompt.ordinal : Math.max(best, prompt.ordinal);
  }
  return best;
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-v3-')));
  repo = path.join(tmpDir, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
});

afterEach(() => {
  for (const provider of providers) provider.dispose();
  providers = [];
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('usage cache files', () => {
  it('ignores files of older versions, writes the current one beside them, and leaves them alone', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    const first = await collectUsageEvents({ providers: [provider] });
    expect(USAGE_CACHE_VERSION).toBe(4);
    expect(cacheFiles()).toEqual(['claude-code--s1.v4.json']);

    // What 0.28 wrote (version 2, unversioned name) and what 0.29 to 0.32.0
    // wrote (version 3, `.v3.json`), both with the same fingerprint.
    const v4Path = path.join(getUsageCacheDir(), 'claude-code--s1.v4.json');
    const v3Path = path.join(getUsageCacheDir(), 'claude-code--s1.v3.json');
    const v2Path = path.join(getUsageCacheDir(), 'claude-code--s1.json');
    const v4 = JSON.parse(fs.readFileSync(v4Path, 'utf8'));
    const v3Content = JSON.stringify({
      ...v4,
      version: 3,
      events: v4.events.map(({ rp: _rp, ...event }: Record<string, unknown>) => event),
    });
    const v2Content = JSON.stringify({
      ...v4,
      version: 2,
      events: v4.events.map(({ t, m, i, o, cw, cr, bo, tt }: Record<string, unknown>) => ({
        t,
        m,
        i,
        o,
        cw,
        cr,
        bo,
        tt,
      })),
    });
    const old = new Date(Date.UTC(2026, 0, 1));
    const olderFiles: Array<[string, string]> = [
      [v2Path, v2Content],
      [v3Path, v3Content],
    ];
    for (const [file, content] of olderFiles) {
      fs.writeFileSync(file, content);
      fs.utimesSync(file, old, old);
    }
    fs.unlinkSync(v4Path);

    const second = await collectUsageEvents({ providers: [provider] });
    expect(second.cacheMisses).toBe(1);
    expect(second.cacheHits).toBe(0);
    expect(second.events).toEqual(first.events);
    expect(cacheFiles()).toEqual([
      'claude-code--s1.json',
      'claude-code--s1.v3.json',
      'claude-code--s1.v4.json',
    ]);
    for (const [file, content] of olderFiles) {
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
      expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
    }

    // Older files are never read, even when they are the only ones; the
    // current version's file is.
    const third = await collectUsageEvents({ providers: [provider] });
    expect(third.cacheHits).toBe(1);
    for (const [file] of olderFiles) expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
  });

  it('rejects a file under the current name that does not carry the current version', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    await collectUsageEvents({ providers: [provider] });
    const current = path.join(getUsageCacheDir(), `claude-code--s1.v${USAGE_CACHE_VERSION}.json`);
    const cached = JSON.parse(fs.readFileSync(current, 'utf8'));
    fs.writeFileSync(current, JSON.stringify({ ...cached, version: 3 }));
    expect((await collectUsageEvents({ providers: [provider] })).cacheMisses).toBe(1);
  });

  it('ages out unversioned and older-version files alongside current ones', () => {
    const dir = path.join(tmpDir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const names = [
      'claude-code--a.json',
      'claude-code--b.v3.json',
      'codex--c.v3.json',
      'codex--d.json',
      'codex--e.v4.json',
    ];
    names.forEach((name, index) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, '{}');
      const time = new Date(Date.UTC(2026, 8, 4, 12, index));
      fs.utimesSync(filePath, time, time);
    });
    expect(pruneUsageCache(3, dir)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'codex--c.v3.json',
      'codex--d.json',
      'codex--e.v4.json',
    ]);
  });
});

describe('reasoning tokens', () => {
  it('keeps Codex reasoning tokens through the cache without changing the priced cost', async () => {
    const id = '019d86b0-b20c-7b02-a3b2-000000000001';
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1),
      codexUser(['explain this'], 2),
      codexCall(3, REASONING_CALL, REASONING_CALL),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(miss.cacheMisses).toBe(1);
    expect(hit.cacheHits).toBe(1);

    for (const result of [miss, hit]) {
      expect(result.events).toHaveLength(1);
      const [event] = result.events;
      expect(event.tokens).toEqual({
        inputTokens: 8_000,
        outputTokens: 3_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 4_000,
        totalTokens: 15_000,
        reasoningTokens: 2_000,
      });
      expect(event.costProvenance).toBe('model-catalog');
      // Pinned to what 0.28 priced this event at: reasoning is inside the
      // 3 000 output tokens and is not priced a second time.
      expect(event.costUsd).toBeCloseTo(0.0405, 12);
      const pricing = getModelPricing(CODEX_MODEL)!;
      expect(event.costUsd).toBeCloseTo(
        (8_000 * pricing.inputCostPerMillion +
          4_000 * pricing.cacheReadCostPerMillion +
          3_000 * pricing.outputCostPerMillion) /
          1_000_000,
        12,
      );
    }
    const cached = JSON.parse(
      fs.readFileSync(
        path.join(getUsageCacheDir(), `codex--${id}.v${USAGE_CACHE_VERSION}.json`),
        'utf8',
      ),
    );
    expect(cached.events[0]).toMatchObject({ o: 3_000, bo: 3_000, rt: 2_000 });
  });

  it('leaves reasoningTokens off events that report none', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const result = await collectUsageEvents({ providers: [claude()], noCache: true });
    expect(result.events[0].tokens).not.toHaveProperty('reasoningTokens');
  });
});

describe('long-context tiers', () => {
  const TIERED_MODEL = 'gpt-5.4';

  /** USD of disjoint Codex usage at `rates` (no cache writes). */
  function costAt(
    rates: {
      inputCostPerMillion: number;
      cacheReadCostPerMillion: number;
      outputCostPerMillion: number;
    },
    uncached: number,
    cacheRead: number,
    output: number,
  ): number {
    return (
      (uncached * rates.inputCostPerMillion +
        cacheRead * rates.cacheReadCostPerMillion +
        output * rates.outputCostPerMillion) /
      1_000_000
    );
  }

  function tieredPricing() {
    const pricing = getModelPricing(TIERED_MODEL)!;
    const tier = pricing.tiers?.[0];
    expect(tier?.aboveInputTokens).toBe(272_000);
    return { pricing, tier: tier! };
  }

  function cachedEvents(id: string): Array<Record<string, unknown>> {
    return JSON.parse(
      fs.readFileSync(
        path.join(getUsageCacheDir(), `codex--${id}.v${USAGE_CACHE_VERSION}.json`),
        'utf8',
      ),
    ).events;
  }

  it('prices a running-total difference and a restarted total at base rates', async () => {
    const { pricing } = tieredPricing();
    const id = '019d86b0-b20c-7b02-a3b2-0000000000a1';
    // No `last_token_usage`: the first count is the growth from nothing (it
    // may span several calls), and the second, lower one restarts the
    // counter, so its whole total is the usage. Each prompt passes 272K.
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1, TIERED_MODEL),
      codexUser(['resume the work'], 2),
      codexTotalOnly(3, {
        input_tokens: 300_000,
        cached_input_tokens: 200_000,
        output_tokens: 2_000,
        total_tokens: 302_000,
      }),
      codexTotalOnly(4, {
        input_tokens: 290_000,
        cached_input_tokens: 250_000,
        output_tokens: 1_000,
        total_tokens: 291_000,
      }),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    for (const result of [miss, hit]) {
      expect(result.events.map((event) => event.costUsd)).toEqual([
        expect.closeTo(costAt(pricing, 100_000, 200_000, 2_000), 12),
        expect.closeTo(costAt(pricing, 40_000, 250_000, 1_000), 12),
      ]);
    }
    expect(cachedEvents(id).map((event) => event.rp)).toEqual([undefined, undefined]);
  });

  it("prices one call's prompt past the threshold at the tier's rates", async () => {
    const { tier } = tieredPricing();
    const id = '019d86b0-b20c-7b02-a3b2-0000000000a2';
    const call = { input_tokens: 300_000, cached_input_tokens: 200_000, output_tokens: 2_000 };
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1, TIERED_MODEL),
      codexUser(['read the whole tree'], 2),
      codexCall(3, call, call),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    for (const result of [miss, hit]) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0].costUsd).toBeCloseTo(costAt(tier, 100_000, 200_000, 2_000), 12);
    }
    expect(cachedEvents(id)[0]).toMatchObject({ rp: 300_000 });
  });
});

describe('subagent attribution', () => {
  it('tags Claude subagent transcript events with the agent id and parent session', async () => {
    const main = claudeFile(repo, 'parent-session');
    writeJsonl(main, [claudeUser('delegate this', 1), claudeAssistant('msg_main', 2)]);
    const subDir = path.join(path.dirname(main), 'parent-session', 'subagents');
    writeJsonl(path.join(subDir, 'agent-a0a27a478cf393505.jsonl'), [
      claudeUser('subagent task', 3, { isSidechain: true }),
      claudeAssistant('msg_sub', 4, { isSidechain: true }),
    ]);
    const provider = claude();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    expect(hit.events).toEqual(miss.events);

    expect(miss.events.map((event) => [event.requestId, event.subagent])).toEqual([
      ['msg_main', undefined],
      [
        'msg_sub',
        {
          agentId: 'a0a27a478cf393505',
          parentSessionId: 'parent-session',
          rootSessionId: 'parent-session',
          kind: 'subagent',
        },
      ],
    ]);
    expect(miss.events[1].parentPromptOrdinal).toBe(0);
    expect(miss.events.every((event) => event.sessionId === 'parent-session')).toBe(true);
    expect(miss.events[0]).not.toHaveProperty('subagent');
  });

  it('tags Codex spawned subagents and forks with their parent from the first line', async () => {
    const parentId = '019d86b0-b20c-7b02-a3b2-00000000000a';
    const spawnedId = '019d86b0-b20c-7b02-a3b2-00000000000b';
    const forkId = '019d86b0-b20c-7b02-a3b2-00000000000c';
    const call = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 };
    codexRollout(parentId, [
      codexMeta(repo, 'cli', { id: parentId }),
      codexTurn(1),
      codexUser(['parent prompt'], 2),
      codexCall(3, call, call),
    ]);
    codexRollout(spawnedId, [
      codexMeta(
        repo,
        {
          subagent: {
            thread_spawn: { parent_thread_id: parentId, depth: 1, agent_nickname: 'Scout' },
          },
        },
        { id: spawnedId, forked_from_id: parentId, parent_thread_id: parentId },
      ),
      codexTurn(4),
      codexCall(5, call, call),
    ]);
    codexRollout(forkId, [
      codexMeta(repo, 'cli', { id: forkId, forked_from_id: parentId }),
      codexTurn(6),
      codexUser(['forked prompt'], 7),
      codexCall(8, call, call),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(3);
    expect(hit.events).toEqual(miss.events);

    const bySession = new Map(miss.events.map((event) => [event.sessionId, event]));
    expect(bySession.get(parentId)).not.toHaveProperty('subagent');
    expect(bySession.get(spawnedId)?.subagent).toEqual({
      agentId: spawnedId,
      parentSessionId: parentId,
      rootSessionId: parentId,
      kind: 'subagent',
    });
    // It started (session_meta timestamp) before the parent's first prompt.
    expect(bySession.get(spawnedId)?.parentPromptOrdinal).toBeNull();
    expect(bySession.get(forkId)?.subagent).toEqual({
      agentId: forkId,
      parentSessionId: parentId,
      rootSessionId: parentId,
      kind: 'fork',
    });
    expect(bySession.get(forkId)).not.toHaveProperty('parentPromptOrdinal');
    // Subagent and fork rollouts carry no human prompts of their own.
    expect(bySession.get(parentId)?.promptOrdinal).toBe(0);
    expect(bySession.get(spawnedId)?.promptOrdinal).toBeNull();
    expect(bySession.get(forkId)?.promptOrdinal).toBeNull();
  });

  it("counts only a forked child's own records", async () => {
    codexRollout(CHILD_ID, childRollout({ cwd: repo }));
    const first = await collectUsageEvents({ providers: [codex()] });
    // 300 + 200 of its own; the 5000 in the parent history the fork embeds is not counted.
    expect(first.events.map((event) => event.tokens.inputTokens)).toEqual([300, 200]);
    expect(first.events[0].subagent).toEqual({
      agentId: CHILD_ID,
      parentSessionId: PARENT_ID,
      rootSessionId: PARENT_ID,
      kind: 'subagent',
    });
    // The root's rollout is not there.
    expect(first.events[0].parentPromptOrdinal).toBeNull();
  });
});

describe('prompt ordinals', () => {
  it('match collectPromptHistory for a Claude session with subagents and a correction', async () => {
    const main = claudeFile(repo, 'ordinals');
    const split = (second: number, output: number, stop: string | null) =>
      claudeAssistant(
        'msg_split',
        second,
        {},
        {
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 30 },
        },
      );
    writeJsonl(main, [
      claudeAssistant('msg_before', 1),
      claudeUser('first prompt', 2),
      // One response written as split lines whose usage grows: a correction.
      split(3, 1, null),
      split(4, 1, null),
      split(5, 25, 'end_turn'),
      claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }], 6),
      claudeAssistant('msg_tool_loop', 7),
      claudeUser('<local-command-stdout>ok</local-command-stdout>', 8),
      claudeUser('no timestamp', 9, { timestamp: undefined }),
      claudeAssistant('msg_after_untimed', 10),
      claudeUser('second prompt', 11, { cwd: path.join(repo) }),
      claudeAssistant('msg_second', 12),
      claudeUser('third prompt', 20),
      claudeAssistant('msg_third', 21),
    ]);
    const subDir = path.join(path.dirname(main), 'ordinals', 'subagents');
    writeJsonl(path.join(subDir, 'agent-first.jsonl'), [
      claudeUser('subagent task', 13, { isSidechain: true }),
      claudeAssistant('msg_sub_1', 14, { isSidechain: true }),
      claudeAssistant('msg_sub_2', 15, { isSidechain: true }),
    ]);
    writeJsonl(path.join(subDir, 'agent-second.jsonl'), [
      claudeAssistant('msg_sub_3', 22, { isSidechain: true }),
    ]);

    const provider = claude();
    const usage = await collectUsageEvents({ providers: [provider] });
    const history = await collectPromptHistory({ workspacePaths: [repo] });

    expect(history.entries.map((entry) => [entry.ordinal, entry.text])).toEqual([
      [0, 'first prompt'],
      [2, 'second prompt'],
      [3, 'third prompt'],
    ]);
    // The split response is one call, its correction merged in.
    const splitEvent = usage.events.find((event) => event.requestId === 'msg_split');
    expect(splitEvent?.tokens.outputTokens).toBe(25);
    expect(usage.events.filter((event) => event.requestId === 'msg_split')).toHaveLength(1);

    expect(usage.events.map((event) => [event.requestId, event.promptOrdinal])).toEqual([
      ['msg_before', null],
      ['msg_split', 0],
      ['msg_tool_loop', 0],
      // After an untimed prompt (ordinal 1): it cannot be placed, so the
      // call stays with the last placed prompt.
      ['msg_after_untimed', 0],
      ['msg_second', 2],
      ['msg_sub_1', 2],
      ['msg_sub_2', 2],
      ['msg_third', 3],
      ['msg_sub_3', 3],
    ]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, history.entries));
    }

    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    expect(hit.events.map((event) => event.promptOrdinal)).toEqual(
      usage.events.map((event) => event.promptOrdinal),
    );
  });

  it('match collectPromptHistory for an interactive Codex session', async () => {
    const id = '019d86b0-b20c-7b02-a3b2-000000000002';
    const one = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
    const two = { input_tokens: 200, cached_input_tokens: 80, output_tokens: 20 };
    const sum = (...calls: Array<Record<string, number>>) => {
      const total: Record<string, number> = {};
      for (const call of calls) {
        for (const [key, value] of Object.entries(call)) total[key] = (total[key] ?? 0) + value;
      }
      return total;
    };
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1),
      codexUser(['<environment_context>\n<cwd>/repo</cwd>\n</environment_context>'], 2),
      codexUser(['first codex prompt'], 3),
      codexCall(4, one, sum(one)),
      // A duplicate token_count (same total) is not another call.
      codexCall(5, one, sum(one)),
      codexCall(6, two, sum(one, two)),
      codexUser(['second codex prompt'], 7),
      codexCall(8, one, sum(one, two, one)),
    ]);
    const usage = await collectUsageEvents({ providers: [codex()] });
    const history = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });

    expect(history.entries.map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(usage.events.map((event) => event.promptOrdinal)).toEqual([0, 0, 1]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, history.entries));
    }
  });

  it('skip a prompt inside a record over the default bound, as collectPromptHistory does', async () => {
    const main = claudeFile(repo, 'oversized');
    writeJsonl(main, [
      claudeUser('before', 1),
      claudeAssistant('msg_1', 2),
      claudeUser('x'.repeat(16 * 1024 * 1024), 3),
      claudeAssistant('msg_2', 4),
      claudeUser('after', 5),
      claudeAssistant('msg_3', 6),
    ]);
    const usage = await collectUsageEvents({ providers: [claude()], noCache: true });
    // Default bounds read 16 MiB per call: page through with the cursor.
    const entries: PromptHistoryEntry[] = [];
    const exclusions: unknown[] = [];
    let cursor: Awaited<ReturnType<typeof collectPromptHistory>>['cursor'] | undefined;
    for (let call = 0; call < 10; call++) {
      const page = await collectPromptHistory({ workspacePaths: [repo], cursor });
      entries.push(...page.entries);
      exclusions.push(...page.exclusions);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }

    expect(entries.map((entry) => [entry.ordinal, entry.text])).toEqual([
      [0, 'before'],
      [1, 'after'],
    ]);
    expect(exclusions).toEqual([expect.objectContaining({ reason: 'oversizedRecord' })]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, entries));
    }
    expect(usage.events.map((event) => event.promptOrdinal)).toEqual([0, 0, 1]);
  });

  it('re-reads ordinals only on a cache miss and leaves them off for appended data until then', async () => {
    const main = claudeFile(repo, 'growing');
    writeJsonl(main, [claudeUser('first', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    const first = await collectUsageEvents({ providers: [provider] });
    expect(first.events.map((event) => event.promptOrdinal)).toEqual([0]);

    appendJsonl(main, [claudeUser('second', 3), claudeAssistant('msg_2', 4)]);
    const second = await collectUsageEvents({ providers: [provider] });
    expect(second.cacheMisses).toBe(1);
    expect(second.events.map((event) => event.promptOrdinal)).toEqual([0, 1]);
  });
});

describe('parent prompt of subagent calls', () => {
  function withoutRecordedRoot(rows: Row[]): Row[] {
    return rows.map((row, index) => {
      if (index !== 0) return row;
      const { session_id: _root, ...payload } = row.payload as Record<string, unknown>;
      return { ...row, payload };
    });
  }

  function writeFamily(options: { parentCwd?: string; recordedRoot?: boolean } = {}) {
    const recorded = options.recordedRoot !== false;
    const parent = parentRollout({ cwd: options.parentCwd ?? repo });
    // A second prompt after the child started: the child's calls follow it.
    parent.push({
      timestamp: at(41, 0),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Also check the docs.' }],
      },
    });
    const child = childRollout({ cwd: repo });
    const grandchild = grandchildRollout({ cwd: repo });
    return {
      parent: codexRollout(PARENT_ID, parent),
      child: codexRollout(CHILD_ID, recorded ? child : withoutRecordedRoot(child)),
      grandchild: codexRollout(
        GRANDCHILD_ID,
        recorded ? grandchild : withoutRecordedRoot(grandchild),
      ),
    };
  }

  function bySession(events: UsageEventRecord[]): Map<string, UsageEventRecord> {
    return new Map(events.map((event) => [event.sessionId, event]));
  }

  it('gives a background Claude agent the prompt it started under', async () => {
    const main = claudeFile(repo, 'background');
    writeJsonl(main, [
      claudeUser('start a background agent', 1),
      claudeAssistant('msg_main', 2),
      claudeUser('meanwhile, another thing', 5),
      claudeAssistant('msg_main_2', 6),
    ]);
    const subDir = path.join(path.dirname(main), 'background', 'subagents');
    writeJsonl(path.join(subDir, 'agent-abc123.jsonl'), [
      claudeUser('agent task', 3, { isSidechain: true }),
      claudeAssistant('msg_agent_late', 7, { isSidechain: true }),
    ]);
    const provider = claude();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    expect(hit.events).toEqual(miss.events);
    const agent = miss.events.find((event) => event.requestId === 'msg_agent_late')!;
    // Its call came after prompt 1, but prompt 0 started it.
    expect(agent).toMatchObject({ promptOrdinal: 1, parentPromptOrdinal: 0 });
    const main0 = miss.events.find((event) => event.requestId === 'msg_main')!;
    expect(main0).not.toHaveProperty('parentPromptOrdinal');
  });

  it('follows Codex grandchildren to the root, recorded or by their parent chain', async () => {
    for (const recordedRoot of [true, false]) {
      fs.rmSync(path.join(tmpDir, '.codex'), { recursive: true, force: true });
      writeFamily({ recordedRoot });
      const result = await collectUsageEvents({ providers: [codex()], noCache: true });
      const sessions = bySession(result.events);
      expect(sessions.get(PARENT_ID)).not.toHaveProperty('subagent');
      for (const id of [CHILD_ID, GRANDCHILD_ID]) {
        expect(sessions.get(id), `${id} recorded=${recordedRoot}`).toMatchObject({
          subagent: { rootSessionId: PARENT_ID, kind: 'subagent' },
          // Both started after prompt 0 and before prompt 1.
          parentPromptOrdinal: 0,
          promptOrdinal: null,
        });
      }
      expect(sessions.get(GRANDCHILD_ID)?.subagent?.parentSessionId).toBe(CHILD_ID);
    }
  });

  it('finds a root the since window left out of the listing', async () => {
    const family = writeFamily();
    const old = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(family.parent, old, old);
    const result = await collectUsageEvents({
      providers: [codex()],
      since: '2026-10-31T00:00:00Z',
      noCache: true,
    });
    expect(result.sessions.map((session) => session.sessionId)).not.toContain(PARENT_ID);
    expect(bySession(result.events).get(CHILD_ID)?.parentPromptOrdinal).toBe(0);
  });

  it('gives null for a root outside the scope', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    writeFamily({ parentCwd: elsewhere });
    const result = await collectUsageEvents({
      providers: [codex()],
      workspacePaths: [repo],
      noCache: true,
    });
    const child = bySession(result.events).get(CHILD_ID);
    expect(child?.subagent?.rootSessionId).toBe(PARENT_ID);
    expect(child?.parentPromptOrdinal).toBeNull();
  });

  it('reads an entry written before parent prompts were recorded once', async () => {
    const main = claudeFile(repo, 'legacy');
    writeJsonl(main, [claudeUser('delegate', 1), claudeAssistant('msg_main', 2)]);
    writeJsonl(path.join(path.dirname(main), 'legacy', 'subagents', 'agent-old1.jsonl'), [
      claudeUser('agent task', 3, { isSidechain: true }),
      claudeAssistant('msg_agent', 4, { isSidechain: true }),
    ]);
    writeFamily();
    const providersNow = [claude(), codex()];
    await collectUsageEvents({ providers: providersNow });
    // Strip what an older writer of the same cache version never wrote.
    for (const name of cacheFiles()) {
      const file = path.join(getUsageCacheDir(), name);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete entry.pm;
      delete entry.as;
      if (entry.subagent)
        entry.subagent = {
          agentId: entry.subagent.agentId,
          parentSessionId: entry.subagent.parentSessionId,
        };
      fs.writeFileSync(file, JSON.stringify(entry));
    }
    const reread = await collectUsageEvents({ providers: providersNow });
    // The Claude session with a subagent and the two Codex children; the
    // Codex root needs nothing it lacks.
    expect(reread.cacheMisses).toBe(3);
    expect(reread.cacheHits).toBe(1);
    const again = await collectUsageEvents({ providers: providersNow });
    expect(again.cacheMisses).toBe(0);
    expect(again.events).toEqual(reread.events);
    expect(again.events.find((event) => event.requestId === 'msg_agent')?.parentPromptOrdinal).toBe(
      0,
    );
  });
});
