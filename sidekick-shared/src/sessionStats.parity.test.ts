import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

// The Claude provider reports a missing session home before a missing file,
// so the home lives under the scratch directory: the "source not found"
// reason is then the same on a developer machine and on a bare CI runner.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

// Codex: no SQLite index, so labels come from the events already read.
vi.mock('./providers/codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }
    open(): boolean {
      return false;
    }
    close(): void {}
  },
}));

// OpenCode: no sqlite3 binary and no database file, so the file-storage reader is used.
const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    execSync: () => {
      throw new Error('no git in fixture');
    },
  };
});

import { EventAggregator } from './aggregation/EventAggregator';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { CodexProvider } from './providers/codex';
import { OpenCodeProvider } from './providers/openCode';
import type { SessionProviderBase } from './providers/types';
import { computeSessionFileStats, firstUserPrompt, readSessionFileStats } from './sessionStats';
import { projectSessionTranscript } from './transcript';
import type { SessionEvent, TokenUsage } from './types/sessionEvent';

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

function writeClaudeSession(dir: string): string {
  const sessionPath = path.join(dir, 'claude', 'session-parity.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const rows = [
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:00.000Z',
      message: { role: 'user', content: '  Refactor the   parser so it streams\nlines  ' },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-04T12:00:05.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: CLAUDE_MODEL,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 400,
        },
        content: [
          { type: 'text', text: 'Reading the parser first.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'parser.ts' } },
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:08.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: '[Response truncated after 8 KB]',
          },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'FAIL 1 test', is_error: true },
        ],
      },
    },
    { type: 'summary', timestamp: '2026-09-04T12:00:09.000Z', summary: 'Compacted context' },
    {
      type: 'assistant',
      timestamp: '2026-09-04T12:00:10.000Z',
      message: {
        id: 'msg-2',
        role: 'assistant',
        model: CLAUDE_MODEL,
        usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 100 },
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ];
  // No trailing newline: the last line only surfaces when the reader is flushed.
  fs.writeFileSync(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return sessionPath;
}

function writeCodexSession(dir: string): string {
  const sessionPath = path.join(
    dir,
    'codex',
    'sessions',
    '2026',
    '09',
    '04',
    'rollout-2026-09-04T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
  );
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const rows = [
    {
      timestamp: '2026-09-04T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019d86b0-b20c-7b02-a3b2-efe5c1ed7122', cwd: '/work/project', source: 'cli' },
    },
    {
      timestamp: '2026-09-04T12:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex', cwd: '/work/project' },
    },
    {
      timestamp: '2026-09-04T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Please inspect the code.' }],
      },
    },
    {
      timestamp: '2026-09-04T12:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
      },
    },
    {
      timestamp: '2026-09-04T12:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-read',
        name: 'Read',
        arguments: '{"file_path":"src/index.ts"}',
      },
    },
    {
      timestamp: '2026-09-04T12:00:06.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-read', output: 'contents' },
    },
    {
      timestamp: '2026-09-04T12:00:09.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 400 },
        },
      },
    },
  ];
  fs.writeFileSync(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return sessionPath;
}

function writeOpenCodeSession(dataHome: string): string {
  const storage = path.join(dataHome, 'opencode', 'storage');
  const sessionId = 'ses_parity';
  const sessionPath = path.join(storage, 'session', 'proj', `${sessionId}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({ id: sessionId, title: '' }));

  const messageDir = path.join(storage, 'message', sessionId);
  fs.mkdirSync(messageDir, { recursive: true });
  const t0 = Date.parse('2026-09-04T12:00:00Z');
  const messages = [
    {
      id: 'msg_a',
      sessionID: sessionId,
      role: 'user',
      tokens: { input: 0, output: 0 },
      time: { created: t0 },
      parts: [{ id: 'prt_a1', type: 'text', text: 'Summarise the repo layout' }],
    },
    {
      id: 'msg_b',
      sessionID: sessionId,
      role: 'assistant',
      modelID: CLAUDE_MODEL,
      providerID: 'anthropic',
      tokens: { input: 200, output: 80, cacheRead: 300, cacheWrite: 10 },
      time: { created: t0 + 5_000, completed: t0 + 9_000 },
      cost: 0.0123,
      parts: [
        { id: 'prt_b1', type: 'text', text: 'Looking now.' },
        {
          id: 'prt_b2',
          type: 'tool-invocation',
          callID: 'call-1',
          tool: 'Read',
          state: { status: 'completed', input: { file: 'README.md' }, output: 'ok' },
        },
        {
          id: 'prt_b3',
          type: 'tool-invocation',
          callID: 'call-2',
          tool: 'Bash',
          state: { status: 'error', input: { command: 'ls' }, error: 'boom' },
        },
      ],
    },
  ];
  for (const { parts, ...message } of messages) {
    fs.writeFileSync(path.join(messageDir, `${message.id}.json`), JSON.stringify(message));
    const partDir = path.join(storage, 'part', message.id);
    fs.mkdirSync(partDir, { recursive: true });
    for (const part of parts) {
      fs.writeFileSync(
        path.join(partDir, `${part.id}.json`),
        JSON.stringify({ ...part, messageID: message.id }),
      );
    }
  }
  return sessionPath;
}

function drain(provider: SessionProviderBase, sessionPath: string): SessionEvent[] {
  const reader = provider.createReader(sessionPath);
  const events = reader.readAll();
  reader.flush();
  return events;
}

function aggregate(provider: SessionProviderBase, events: SessionEvent[]) {
  const aggregator = new EventAggregator({
    providerId: provider.id,
    computeContextSize: provider.computeContextSize
      ? (usage) =>
          provider.computeContextSize!({ ...usage, model: '', timestamp: new Date() } as TokenUsage)
      : undefined,
  });
  for (const event of events) aggregator.processEvent(event);
  return aggregator.getMetrics();
}

describe('session stats parity', () => {
  let providers: Array<{ provider: SessionProviderBase; sessionPath: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-stats-parity-'));
    fs.mkdirSync(path.join(tmpDir, '.claude', 'projects'), { recursive: true });
    vi.stubEnv('XDG_DATA_HOME', path.join(tmpDir, 'data'));
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' });
    });
    providers = [
      { provider: new ClaudeCodeProvider(), sessionPath: writeClaudeSession(tmpDir) },
      { provider: new CodexProvider(), sessionPath: writeCodexSession(tmpDir) },
      {
        provider: new OpenCodeProvider(),
        sessionPath: writeOpenCodeSession(path.join(tmpDir, 'data')),
      },
    ];
  });

  afterEach(() => {
    for (const { provider } of providers) provider.dispose();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the same totals as a direct aggregator drain and the transcript projection', () => {
    for (const { provider, sessionPath } of providers) {
      const stats = provider.readSessionStats(sessionPath);
      const events = drain(provider, sessionPath);
      const metrics = aggregate(provider, events);
      const transcript = projectSessionTranscript(events, {
        provider: provider.id,
        fidelity: 'full',
      });

      expect(stats.availability, provider.id).toBe('full');
      expect(stats.tokens, provider.id).toEqual({
        input: metrics.tokens.inputTokens,
        output: metrics.tokens.outputTokens,
        cacheWrite: metrics.tokens.cacheWriteTokens,
        cacheRead: metrics.tokens.cacheReadTokens,
      });
      expect(stats.tokens, provider.id).toEqual({
        input: transcript.usage.totals.uncachedInputTokens,
        output: transcript.usage.totals.outputTokens,
        cacheWrite: transcript.usage.totals.cacheWriteTokens,
        cacheRead: transcript.usage.totals.cacheReadTokens,
      });
      expect(stats.costUsd, provider.id).toBe(metrics.tokens.costUsd);
      expect(stats.costProvenance, provider.id).toBe(metrics.tokens.costProvenance);
      expect(stats.unpricedCalls, provider.id).toBe(metrics.tokens.unpricedCalls);
      expect(stats.costUsd, provider.id).toBeCloseTo(transcript.usage.pricedCostUsd, 6);
      expect(stats.messageCount, provider.id).toBe(metrics.messageCount);
      expect(stats.compactionEstimate, provider.id).toBe(metrics.compactionCount);
      expect(stats.truncationCount, provider.id).toBe(metrics.truncationCount);
      expect(stats.reportedCost, provider.id).toBe(stats.costUsd);
      expect(stats.startTime, provider.id).toBe(metrics.sessionStartTime);
      expect(stats.endTime, provider.id).toBe(metrics.lastEventTime);

      // Per-model totals use the cache-inclusive vocabulary for every provider.
      for (const model of metrics.modelStats) {
        expect(stats.modelUsage[model.model], `${provider.id}:${model.model}`).toEqual({
          calls: model.calls,
          tokens: model.tokens,
          costUsd: model.cost,
          priced: model.priced !== false,
        });
      }
      expect(stats.costProvenance, provider.id).not.toBe('none');
    }
  });

  it('derives the label from the first user prompt without a second file open', () => {
    const [claude, codex, opencode] = providers;
    const claudeStats = claude.provider.readSessionStats(claude.sessionPath);
    expect(claudeStats.label).toBe('Refactor the parser so it streams lines');
    // Same answer as the prefix-based label path, so previews and stats agree.
    expect(claude.provider.extractSessionLabel(claude.sessionPath)).toBe(claudeStats.label);

    expect(codex.provider.readSessionStats(codex.sessionPath).label).toBe(
      'Please inspect the code.',
    );
    expect(opencode.provider.readSessionStats(opencode.sessionPath).label).toBe(
      'Summarise the repo layout',
    );
  });

  it('counts Claude compactions, truncated tool output, and failed tools through the aggregator', () => {
    const [claude] = providers;
    const stats = claude.provider.readSessionStats(claude.sessionPath);

    expect(stats.messageCount).toBe(4);
    expect(stats.tokens).toEqual({ input: 130, output: 60, cacheWrite: 20, cacheRead: 500 });
    // Cache-inclusive per-model total (the old scan reported input + output only).
    expect(stats.modelUsage[CLAUDE_MODEL]).toMatchObject({ calls: 2, tokens: 710, priced: true });
    expect(stats.modelUsage[CLAUDE_MODEL].costUsd).toBeCloseTo(stats.costUsd, 9);
    expect(stats.compactionEstimate).toBe(1);
    expect(stats.truncationCount).toBe(1);
    expect(stats.toolUsage).toEqual({ Read: 1, Bash: 1 });
    expect(stats.toolFailures).toEqual({ Bash: 1 });
    expect(stats.costProvenance).toBe('estimated');
    expect(stats.costUsd).toBeGreaterThan(0);
    // The final row has no trailing newline and is only read on flush().
    expect(stats.endTime).toBe('2026-09-04T12:00:10.000Z');
  });

  it('reports OpenCode provider-reported cost and tool failures instead of hardcoded zeros', () => {
    const [, , opencode] = providers;
    const stats = opencode.provider.readSessionStats(opencode.sessionPath);

    expect(stats.tokens).toEqual({ input: 200, output: 80, cacheWrite: 10, cacheRead: 300 });
    expect(stats.costProvenance).toBe('reported');
    expect(stats.costUsd).toBeCloseTo(0.0123, 6);
    expect(stats.toolUsage).toEqual({ Read: 1, Bash: 1 });
    expect(stats.toolFailures).toEqual({ Bash: 1 });
    expect(stats.availability).toBe('full');
  });

  it('marks a missing source unavailable with a reason instead of silent zeros', () => {
    const claude = new ClaudeCodeProvider();
    const missing = claude.readSessionStats(path.join(tmpDir, 'claude', 'missing.jsonl'));
    expect(missing).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'Session source not found.',
      messageCount: 0,
      costProvenance: 'none',
      label: null,
    });
    expect(missing.tokens).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

    const opencode = new OpenCodeProvider();
    const noSource = opencode.readSessionStats(
      path.join(tmpDir, 'data', 'opencode', 'storage', 'session', 'proj', 'ses_none.json'),
    );
    expect(noSource.availability).toBe('unavailable');
    expect(noSource.unavailableReason).toContain('db_missing');
    opencode.dispose();
  });

  it('exposes the pure helpers for callers that already hold the events', () => {
    const [claude] = providers;
    const events = drain(claude.provider, claude.sessionPath);
    const stats = computeSessionFileStats(events, {
      providerId: 'claude-code',
      sessionId: 'session-parity',
      filePath: claude.sessionPath,
    });
    expect(stats).toEqual(readSessionFileStats(claude.provider, claude.sessionPath));

    expect(firstUserPrompt(events)).toBe('Refactor the parser so it streams lines');
    expect(firstUserPrompt(events, 20)).toBe('Refactor the pars...');
    expect(firstUserPrompt([])).toBeNull();
  });
});

describe('OpenCode file reader positions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-opencode-seek-'));
    vi.stubEnv('XDG_DATA_HOME', path.join(tmpDir, 'data'));
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn sqlite3 ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeks by message count so a restored reader emits only newer messages', () => {
    const sessionPath = writeOpenCodeSession(path.join(tmpDir, 'data'));
    const provider = new OpenCodeProvider();

    const full = provider.createReader(sessionPath);
    const all = full.readAll();
    expect(all.length).toBeGreaterThan(1);
    expect(full.getPosition()).toBe(2);

    const resumed = provider.createReader(sessionPath);
    resumed.seekTo(1);
    const remaining = resumed.readNew();
    expect(remaining.length).toBeLessThan(all.length);
    expect(remaining.every((event) => event.timestamp >= '2026-09-04T12:00:05')).toBe(true);
    expect(resumed.getPosition()).toBe(2);
    expect(resumed.readNew()).toEqual([]);
    provider.dispose();
  });
});
