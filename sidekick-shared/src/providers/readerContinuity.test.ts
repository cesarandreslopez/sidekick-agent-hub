/**
 * Both JSONL readers notice a session file that was rewritten or replaced
 * while open (not only one that shrank), start over from offset 0, and say so
 * through wasTruncated() / lastReset().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventAggregator } from '../aggregation/EventAggregator';
import { setConfigDir } from '../paths';
import type { SessionEvent } from '../types/sessionEvent';
import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';
import type { ProviderId, SessionReader } from './types';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-reader-continuity-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Moves the mtime forward, as a later write on a coarse-clock filesystem would. */
function touchLater(target: string, ms = 5_000): void {
  fs.utimesSync(target, new Date(), new Date(Date.now() + ms));
}

/** Atomically puts `content` at `target` as a new file (new inode). */
function renameReplace(target: string, content: string): void {
  fs.writeFileSync(`${target}.next`, content);
  fs.renameSync(`${target}.next`, target);
}

/** Follows a reader the way the monitors do: a reset discards the aggregate first. */
function follower(providerId: ProviderId, reader: SessionReader) {
  let aggregator = new EventAggregator({ providerId });
  return {
    poll(): SessionEvent[] {
      const events = reader.readNew();
      if (reader.wasTruncated()) aggregator = new EventAggregator({ providerId });
      for (const event of events) aggregator.processEvent(event);
      return events;
    },
    tokens: () => aggregator.getMetrics().tokens,
  };
}

/** Token totals of a fresh full read of the file now at `file`. */
function freshTokens(providerId: ProviderId, reader: SessionReader) {
  const aggregator = new EventAggregator({ providerId });
  for (const event of reader.readAll()) aggregator.processEvent(event);
  return aggregator.getMetrics().tokens;
}

// ── Claude Code ─────────────────────────────────────────────────────────────

/** One line of a Claude response; split responses repeat their usage on every line. */
function claudeBlock(id: string, output: number, text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-01T12:00:00Z',
      message: {
        id,
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: 10,
          output_tokens: output,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 20,
        },
      },
    }) + '\n'
  );
}

function claudeUser(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: '2026-11-01T12:00:00Z',
      message: { role: 'user', content: text },
    }) + '\n'
  );
}

/** A session whose first response (msg_1) is written as two lines repeating its usage. */
const CLAUDE_SESSION =
  claudeUser('go') +
  claudeBlock('msg_1', 4, 'thinking') +
  claudeBlock('msg_1', 323, 'done') +
  claudeUser('next') +
  claudeBlock('msg_2', 7, 'ok');

describe('ClaudeCodeReader continuity', () => {
  const claude = new ClaudeCodeProvider();

  it('continues without a reset while the file is only appended to', () => {
    fs.writeFileSync(file, claudeUser('go'));
    const reader = claude.createReader(file);
    reader.readNew();
    fs.appendFileSync(file, claudeBlock('msg_1', 4, 'thinking'));
    touchLater(file);
    expect(reader.readNew()).toHaveLength(1);
    expect(reader.wasTruncated()).toBe(false);
    expect(reader.lastReset?.()).toBeNull();
  });

  it('restarts on a same-size rewrite and counts a split response once', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = claude.createReader(file);
    const follow = follower('claude-code', reader);
    follow.poll();
    const size = fs.statSync(file).size;
    expect(follow.tokens().outputTokens).toBe(323 + 7);

    fs.writeFileSync(file, CLAUDE_SESSION.replace('thinking', 'THINKING'));
    touchLater(file);
    expect(fs.statSync(file).size).toBe(size);
    const events = follow.poll();
    expect(reader.wasTruncated()).toBe(true);
    expect(reader.lastReset?.()).toEqual({ reason: 'rewritten', previousPosition: size });
    expect(events.length).toBeGreaterThan(0);
    // The deduper started over too: msg_1 is counted once, not dropped as already seen.
    expect(follow.tokens()).toEqual(freshTokens('claude-code', claude.createReader(file)));
    expect(follow.tokens().outputTokens).toBe(323 + 7);

    // The next read continues normally.
    expect(follow.poll()).toEqual([]);
    expect(reader.lastReset?.()).toBeNull();
  });

  it('restarts on a larger rewrite of the head', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = claude.createReader(file);
    const follow = follower('claude-code', reader);
    follow.poll();
    fs.writeFileSync(file, claudeUser('a different start') + CLAUDE_SESSION);
    touchLater(file);
    follow.poll();
    expect(reader.lastReset?.()).toMatchObject({ reason: 'rewritten' });
    expect(follow.tokens()).toEqual(freshTokens('claude-code', claude.createReader(file)));
  });

  it('restarts on a rename-replace with identical content', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = claude.createReader(file);
    const follow = follower('claude-code', reader);
    follow.poll();
    renameReplace(file, CLAUDE_SESSION + claudeBlock('msg_3', 9, 'more'));
    follow.poll();
    expect(reader.lastReset?.()).toMatchObject({ reason: 'replaced' });
    expect(follow.tokens()).toEqual(freshTokens('claude-code', claude.createReader(file)));
    expect(follow.tokens().outputTokens).toBe(323 + 7 + 9);
  });

  it('restarts on a truncation and reports the position it left', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = claude.createReader(file);
    const follow = follower('claude-code', reader);
    follow.poll();
    const size = fs.statSync(file).size;
    fs.truncateSync(file, Buffer.byteLength(claudeUser('go')));
    follow.poll();
    expect(reader.lastReset?.()).toEqual({ reason: 'truncated', previousPosition: size });
    expect(follow.tokens().outputTokens).toBe(0);
  });

  it('adopts the file after seekTo() instead of comparing it with an earlier one', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = claude.createReader(file);
    reader.readNew();
    const position = reader.getPosition();
    fs.writeFileSync(file, CLAUDE_SESSION.replace('thinking', 'THINKING') + claudeUser('later'));
    touchLater(file);
    reader.seekTo(position);
    expect(reader.readNew()).toHaveLength(1);
    expect(reader.wasTruncated()).toBe(false);
  });

  it('reads a missing file as no events, then adopts it when it appears', () => {
    const reader = claude.createReader(file);
    expect(reader.readNew()).toEqual([]);
    expect(reader.wasTruncated()).toBe(false);
    fs.writeFileSync(file, claudeUser('go'));
    expect(reader.readNew()).toHaveLength(1);
    expect(reader.wasTruncated()).toBe(false);
  });
});

// ── Codex ───────────────────────────────────────────────────────────────────

const codexLine = (row: unknown) => JSON.stringify(row) + '\n';
const codexTotal = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  total_tokens: input + output,
});
/** A cumulative token_count: the parser counts the growth since the previous one. */
const codexTokens = (input: number, output: number, second: number) =>
  codexLine({
    type: 'event_msg',
    timestamp: `2026-11-01T12:00:0${second}Z`,
    payload: { type: 'token_count', info: { total_token_usage: codexTotal(input, output) } },
  });
const codexAssistant = (text: string, second: number) =>
  codexLine({
    type: 'response_item',
    timestamp: `2026-11-01T12:00:0${second}Z`,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

const CODEX_SESSION =
  codexLine({ type: 'session_meta', payload: { id: 'session', cwd: '/workspace' } }) +
  codexLine({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/workspace' } }) +
  codexAssistant('first', 1) +
  codexTokens(1000, 100, 2) +
  codexAssistant('second', 3) +
  codexTokens(1500, 150, 4);

describe('CodexReader continuity', () => {
  const codex = new CodexProvider();

  it('continues without a reset while the rollout is only appended to', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const reader = codex.createReader(file);
    reader.readNew();
    fs.appendFileSync(file, codexAssistant('third', 5));
    touchLater(file);
    expect(reader.readNew()).toHaveLength(1);
    expect(reader.lastReset?.()).toBeNull();
  });

  it('restarts on a same-size rewrite with cumulative totals counted from zero again', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const reader = codex.createReader(file);
    const follow = follower('codex', reader);
    follow.poll();
    const size = fs.statSync(file).size;
    const before = follow.tokens();
    expect(before.outputTokens).toBe(150);

    fs.writeFileSync(file, CODEX_SESSION.replace('first', 'FIRST'));
    touchLater(file);
    follow.poll();
    expect(reader.wasTruncated()).toBe(true);
    expect(reader.lastReset?.()).toEqual({ reason: 'rewritten', previousPosition: size });
    expect(follow.tokens()).toEqual(freshTokens('codex', codex.createReader(file)));
    expect(follow.tokens()).toEqual(before);
  });

  it('restarts on a larger rewrite of the head', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const reader = codex.createReader(file);
    const follow = follower('codex', reader);
    follow.poll();
    fs.writeFileSync(
      file,
      CODEX_SESSION.replace('"id":"session"', '"id":"another-session"') + codexTokens(2000, 300, 5),
    );
    touchLater(file);
    follow.poll();
    expect(reader.lastReset?.()).toMatchObject({ reason: 'rewritten' });
    expect(follow.tokens()).toEqual(freshTokens('codex', codex.createReader(file)));
    expect(follow.tokens().outputTokens).toBe(300);
  });

  it('restarts on a rename-replace and drops a buffered partial line', () => {
    const partial = codexAssistant('unfinished', 5);
    fs.writeFileSync(file, CODEX_SESSION + partial.slice(0, 20));
    const reader = codex.createReader(file);
    const follow = follower('codex', reader);
    follow.poll();
    // The replacement's own last line completes nothing from the old buffer.
    renameReplace(file, CODEX_SESSION + codexAssistant('replacement', 6));
    const events = follow.poll();
    expect(reader.lastReset?.()).toMatchObject({ reason: 'replaced' });
    expect(events).toEqual(codex.createReader(file).readAll());
    expect(follow.tokens()).toEqual(freshTokens('codex', codex.createReader(file)));
  });

  it('restarts on a truncation', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const reader = codex.createReader(file);
    const follow = follower('codex', reader);
    follow.poll();
    const size = fs.statSync(file).size;
    const kept = CODEX_SESSION.slice(0, CODEX_SESSION.indexOf(codexTokens(1500, 150, 4)));
    fs.truncateSync(file, Buffer.byteLength(kept));
    follow.poll();
    expect(reader.lastReset?.()).toEqual({ reason: 'truncated', previousPosition: size });
    expect(follow.tokens().outputTokens).toBe(100);
  });

  it('reports a rollout that no longer reaches a sought position, and replays it', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const original = codex.createReader(file);
    original.readNew();
    const position = original.getPosition();
    const kept = CODEX_SESSION.slice(0, CODEX_SESSION.indexOf(codexAssistant('second', 3)));
    fs.writeFileSync(file, kept);

    const resumed = codex.createReader(file);
    resumed.seekTo(position);
    const events = resumed.readNew();
    expect(resumed.lastReset?.()).toEqual({ reason: 'truncated', previousPosition: position });
    expect(events).toEqual(codex.createReader(file).readAll());
  });
});
