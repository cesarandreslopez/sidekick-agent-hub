/**
 * `readNewBounded()` reads a session in steps whose events, together, equal
 * one `readAll()` + `flush()`: whatever the step size, across multibyte
 * characters, lines longer than a step, CRLF endings, and a trailing line
 * with no newline. A drain stops at the size it started with, any step can
 * restart on a replaced file, and no single `fs.readSync` exceeds 1 MiB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setConfigDir } from '../paths';
import type { SessionEvent } from '../types/sessionEvent';
import { isBoundedReader, type BoundedSessionReader } from './boundedReader';
import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';
import type { SessionReader } from './types';

const readSyncLengths: number[] = [];
/** Fail `fs.readSync` calls on the session file once this many have run (null: never). */
const failReads: { after: number | null; seen: number; path: string } = {
  after: null,
  seen: 0,
  path: '',
};
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      readSyncLengths.push(args[3] as number);
      // Only slice reads (the continuity probe reads at most 4 KiB at 0, or 1 byte).
      if (failReads.after !== null && (args[3] as number) > 4096) {
        failReads.seen += 1;
        if (failReads.seen > failReads.after) {
          throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
        }
      }
      return actual.readSync(...args);
    },
  };
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-bounded-read-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  setConfigDir(undefined);
  failReads.after = null;
  failReads.seen = 0;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function bounded(reader: SessionReader): BoundedSessionReader {
  if (!isBoundedReader(reader)) throw new Error('expected a bounded reader');
  return reader;
}

/** Events of a whole drain at `maxBytes` per step, ended like `readAll()` + `flush()`. */
function drain(reader: SessionReader, maxBytes: number): SessionEvent[] {
  const steps = bounded(reader);
  const events: SessionEvent[] = [];
  for (let step = 0; ; step++) {
    if (step > 1_000_000) throw new Error('drain did not end');
    const result = steps.readNewBounded(maxBytes);
    events.push(...result.events);
    if (result.done) break;
  }
  events.push(...steps.finishBounded());
  return events;
}

function oneShot(reader: SessionReader): SessionEvent[] {
  const events = reader.readAll();
  reader.flush();
  return events;
}

function renameReplace(target: string, content: string): void {
  fs.writeFileSync(`${target}.next`, content);
  fs.renameSync(`${target}.next`, target);
}

const STEP_SIZES = [1, 2, 3, 7, 64, 4096];

// ── Claude Code ─────────────────────────────────────────────────────────────

const line = (row: unknown) => JSON.stringify(row) + '\n';

function claudeUser(text: string, second: number): string {
  return line({
    type: 'user',
    timestamp: `2026-11-01T12:00:${String(second).padStart(2, '0')}Z`,
    message: { role: 'user', content: text },
  });
}

function claudeAssistant(id: string, output: number, text: string, second: number): string {
  return line({
    type: 'assistant',
    timestamp: `2026-11-01T12:00:${String(second).padStart(2, '0')}Z`,
    message: {
      id,
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500 },
    },
  });
}

const CLAUDE_SESSION =
  claudeUser('héllo wörld — 日本語のテキスト 🚀🎉', 1) +
  claudeAssistant('msg-1', 20, 'part one 🧪', 2) +
  // A split response repeats its usage; the deduper counts it once.
  claudeAssistant('msg-1', 40, 'part two 👍', 3) +
  line({ type: 'attachment', timestamp: '2026-11-01T12:00:04Z', attachment: { type: 'x' } }) +
  claudeUser(`long ${'ü'.repeat(6000)}`, 5) +
  claudeAssistant('msg-2', 7, 'ok', 6).replace('\n', '\r\n') +
  claudeUser('après', 7);

describe('ClaudeCodeReader.readNewBounded', () => {
  const claude = new ClaudeCodeProvider();

  it.each(STEP_SIZES)('a drain at %i bytes per step equals readAll + flush', (size) => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const expected = oneShot(claude.createReader(file));
    expect(expected.length).toBeGreaterThan(4);
    const reader = claude.createReader(file);
    expect(drain(reader, size)).toEqual(expected);
    expect(reader.getPosition()).toBe(Buffer.byteLength(CLAUDE_SESSION));
  });

  it('counts a trailing line with no newline only when the drain is finished', () => {
    const content = CLAUDE_SESSION + claudeUser('no newline', 8).trimEnd();
    fs.writeFileSync(file, content);
    const expected = oneShot(claude.createReader(file));
    const reader = bounded(claude.createReader(file));
    let result = reader.readNewBounded(64);
    const events = [...result.events];
    while (!result.done) {
      result = reader.readNewBounded(64);
      events.push(...result.events);
    }
    // Done, yet the position stays before the unterminated line.
    expect(reader.getPosition()).toBe(Buffer.byteLength(CLAUDE_SESSION));
    expect(events).toHaveLength(expected.length - 1);
    events.push(...reader.finishBounded());
    expect(events).toEqual(expected);
  });

  it('stops at the size the drain began with; the next drain reads what was appended', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = bounded(claude.createReader(file));
    const first = reader.readNewBounded(100);
    expect(first.done).toBe(false);
    fs.appendFileSync(file, claudeUser('appended', 9));
    const events = [...first.events];
    let result = first;
    while (!result.done) {
      result = reader.readNewBounded(100);
      events.push(...result.events);
    }
    fs.writeFileSync(path.join(dir, 'before.jsonl'), CLAUDE_SESSION);
    expect(events).toEqual(oneShot(claude.createReader(path.join(dir, 'before.jsonl'))));
    const next = drain(reader, 100);
    expect(next).toHaveLength(1);
    expect(next[0].type).toBe('user');
  });

  it('restarts on the step after a rename-replace and reports it', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = bounded(claude.createReader(file));
    expect(reader.readNewBounded(200).done).toBe(false);
    const replacement = claudeUser('replacement', 1) + claudeAssistant('msg-9', 5, 'new', 2);
    renameReplace(file, replacement);
    const events = drain(reader, 200);
    const again = bounded(claude.createReader(file));
    expect(events).toEqual(oneShot(again));
  });

  it('reports the reset on the step that found it', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = bounded(claude.createReader(file));
    reader.readNewBounded(200);
    renameReplace(file, claudeUser('replacement', 1));
    const step = reader.readNewBounded(200);
    expect(reader.wasTruncated()).toBe(true);
    expect(reader.lastReset?.()?.reason).toBe('replaced');
    expect(step.done).toBe(true);
    expect(step.events).toHaveLength(1);
  });

  it('reads a missing file as done with no events', () => {
    const reader = bounded(claude.createReader(file));
    expect(reader.readNewBounded(64)).toEqual({ events: [], done: true });
  });

  it('rejects a maxBytes that is not a number > 0', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const reader = bounded(claude.createReader(file));
    expect(() => reader.readNewBounded(0)).toThrow(RangeError);
    expect(() => reader.readNewBounded(Number.NaN)).toThrow(RangeError);
  });

  it('readNew after part of a drain continues from where the drain stopped', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const expected = oneShot(claude.createReader(file));
    const reader = claude.createReader(file);
    const partial = bounded(reader).readNewBounded(150).events;
    const rest = reader.readNew();
    reader.flush();
    expect([...partial, ...rest]).toEqual(expected);
  });

  it('never reads more than 1 MiB in one fs.readSync, in readNew() either', () => {
    const big = Array.from({ length: 2500 }, (_, i) =>
      claudeUser(`${i} ${'x'.repeat(1000)}`, i % 60),
    ).join('');
    fs.writeFileSync(file, big);
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    readSyncLengths.length = 0;
    const events = claude.createReader(file).readAll();
    expect(events).toHaveLength(2500);
    expect(Math.max(...readSyncLengths)).toBeLessThanOrEqual(1024 * 1024);
    expect(readSyncLengths.length).toBeGreaterThan(2);
  });
});

// ── Codex ───────────────────────────────────────────────────────────────────

const codexTotal = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  total_tokens: input + output,
});
const codexTokens = (input: number, output: number, second: number) =>
  line({
    type: 'event_msg',
    timestamp: `2026-11-01T12:00:${String(second).padStart(2, '0')}Z`,
    payload: { type: 'token_count', info: { total_token_usage: codexTotal(input, output) } },
  });
const codexAssistant = (text: string, second: number) =>
  line({
    type: 'response_item',
    timestamp: `2026-11-01T12:00:${String(second).padStart(2, '0')}Z`,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

const CODEX_SESSION =
  line({ type: 'session_meta', payload: { id: 'session', cwd: '/workspace' } }) +
  line({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/workspace' } }) +
  codexAssistant('first — ünïcödé 🚀', 1) +
  codexTokens(1000, 100, 2) +
  codexTokens(1000, 100, 3) + // a duplicate total adds nothing
  codexAssistant(`long ${'é'.repeat(5000)}`, 4) +
  line({ type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd: '/workspace' } }) +
  codexTokens(1500, 150, 5).replace('\n', '\r\n') +
  codexAssistant('last', 6);

describe('CodexReader.readNewBounded', () => {
  const codex = new CodexProvider();

  it.each(STEP_SIZES)('a drain at %i bytes per step equals readAll + flush', (size) => {
    fs.writeFileSync(file, CODEX_SESSION);
    const expected = oneShot(codex.createReader(file));
    expect(expected.some((event) => event.message?.usage)).toBe(true);
    const reader = codex.createReader(file);
    expect(drain(reader, size)).toEqual(expected);
    expect(reader.getPosition()).toBe(Buffer.byteLength(CODEX_SESSION));
    expect(reader.getResumeState?.()).toEqual(
      (() => {
        const other = codex.createReader(file);
        oneShot(other);
        return other.getResumeState?.();
      })(),
    );
  });

  it('drops a trailing line with no newline, as flush() does', () => {
    fs.writeFileSync(file, CODEX_SESSION + codexTokens(2000, 300, 7).trimEnd());
    const expected = oneShot(codex.createReader(file));
    expect(drain(codex.createReader(file), 50)).toEqual(expected);
  });

  it('settles a seek in bounded steps, emitting nothing for the prefix', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const full = codex.createReader(file);
    const all = oneShot(full);
    // Seek to the end of the first token_count line.
    const position = CODEX_SESSION.indexOf(codexTokens(1000, 100, 3));
    const reader = bounded(codex.createReader(file));
    reader.seekTo(position);
    const events: SessionEvent[] = [];
    let steps = 0;
    for (;;) {
      const result = reader.readNewBounded(32);
      steps += 1;
      events.push(...result.events);
      if (result.done) break;
    }
    expect(steps).toBeGreaterThan(5);
    // Same events as a reader that parsed the prefix synchronously.
    const sync = codex.createReader(file);
    sync.seekTo(position);
    expect(events).toEqual(sync.readNew());
    expect(events.length).toBeLessThan(all.length);
  });

  it('reports a truncation found while settling a seek', () => {
    fs.writeFileSync(file, CODEX_SESSION);
    const reader = bounded(codex.createReader(file));
    const sought = Buffer.byteLength(CODEX_SESSION) + 100;
    reader.seekTo(sought);
    // Settling parses the prefix in steps and finds the rollout too short…
    expect(reader.readNewBounded(64)).toEqual({ events: [], done: false });
    expect(reader.readNewBounded(1 << 20)).toEqual({ events: [], done: false });
    expect(reader.wasTruncated()).toBe(false);
    // …which the next step reports, reading the rollout from the start.
    const step = reader.readNewBounded(1 << 20);
    expect(reader.lastReset?.()).toEqual({ reason: 'truncated', previousPosition: sought });
    expect(step.done).toBe(true);
    expect(step.events).toEqual(oneShot(codex.createReader(file)));
  });

  it('hands parser state to the provider once per completed drain', () => {
    const windows: number[] = [];
    const provider = new CodexProvider({
      onContextWindowLimit: (limit: number) => windows.push(limit),
    } as ConstructorParameters<typeof CodexProvider>[0]);
    fs.writeFileSync(
      file,
      CODEX_SESSION +
        line({
          type: 'event_msg',
          timestamp: '2026-11-01T12:00:08Z',
          payload: {
            type: 'token_count',
            info: { total_token_usage: codexTotal(3000, 400), model_context_window: 272000 },
          },
        }),
    );
    const reader = provider.createReader(file);
    drain(reader, 16);
    expect(windows.length).toBeLessThanOrEqual(1);
  });
});

// ── Resuming in another reader ──────────────────────────────────────────────

describe('continuity state across readers', () => {
  const claude = new ClaudeCodeProvider();

  function resumed(state: { position: number; resume: unknown; continuity: unknown }) {
    const reader = bounded(claude.createReader(file));
    reader.seekTo(state.position);
    reader.restoreResumeState?.(state.resume);
    expect(reader.restoreContinuity!(state.continuity)).toBe(true);
    return reader;
  }

  function saved(maxBytes: number) {
    const reader = bounded(claude.createReader(file));
    const first = reader.readNewBounded(maxBytes);
    expect(first.done).toBe(false);
    return {
      events: first.events,
      position: reader.getPosition(),
      resume: reader.getResumeState?.(),
      continuity: reader.continuityState!(),
    };
  }

  it('continues an appended file where the first reader committed', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const state = saved(150);
    fs.appendFileSync(file, claudeUser('later', 9));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const reader = resumed(state);
    const rest = drain(reader, 150);
    expect(reader.lastReset?.()).toBeNull();
    expect([...state.events, ...rest]).toEqual(oneShot(claude.createReader(file)));
  });

  it('notices a rewrite between the two readers and starts over', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const state = saved(150);
    fs.writeFileSync(file, CLAUDE_SESSION.replace('héllo', 'HÉLLO'));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const reader = resumed(state);
    const step = reader.readNewBounded(1 << 20);
    expect(reader.lastReset?.()?.reason).toBe('rewritten');
    expect(step.events).toEqual(oneShot(claude.createReader(file)).slice(0, step.events.length));
  });

  it('notices a replaced file between the two readers', () => {
    fs.writeFileSync(file, CLAUDE_SESSION);
    const state = saved(150);
    renameReplace(file, CLAUDE_SESSION);
    const reader = resumed(state);
    reader.readNewBounded(1 << 20);
    expect(reader.lastReset?.()?.reason).toBe('replaced');
  });

  it('rejects a malformed continuity state', () => {
    const reader = bounded(claude.createReader(file));
    expect(reader.restoreContinuity!({ dev: 1, ino: 2 })).toBe(false);
    expect(reader.restoreContinuity!({ dev: 1, ino: 2, mtimeMs: 3, head: { bytes: 1 } })).toBe(
      false,
    );
    expect(reader.restoreContinuity!(null)).toBe(false);
  });
});

// ── Read errors ─────────────────────────────────────────────────────────────

describe('a read error during a bounded step', () => {
  const claude = new ClaudeCodeProvider();
  const codex = new CodexProvider();
  const big = (count: number) =>
    Array.from({ length: count }, (_, i) => claudeUser(`${i} ${'y'.repeat(2000)}`, i % 60)).join(
      '',
    );

  it.each([
    ['Claude Code', () => claude, () => big(1200)],
    [
      'Codex',
      () => codex,
      () =>
        Array.from({ length: 1200 }, (_, i) =>
          codexAssistant(`${i} ${'y'.repeat(2000)}`, i % 60),
        ).join(''),
    ],
  ] as const)('%s: returns what it read and loses nothing', (_name, provider, content) => {
    fs.writeFileSync(file, content());
    const expected = oneShot(provider().createReader(file));
    const reader = bounded(provider().createReader(file));
    // The second 1 MiB slice of the first step fails.
    failReads.after = 1;
    const first = reader.readNewBounded(4 * 1024 * 1024);
    expect(first.done).toBe(true);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(expected.length);
    failReads.after = null;
    // The next drain carries on from where the failed step stopped.
    const rest = drain(reader, 4 * 1024 * 1024);
    expect([...first.events, ...rest]).toEqual(expected);
  });

  it('throws when the step read nothing, and readNew() logs instead', () => {
    fs.writeFileSync(file, big(800));
    failReads.after = 0;
    const reader = bounded(claude.createReader(file));
    expect(() => reader.readNewBounded(1 << 20)).toThrow(/EIO/);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(claude.createReader(file).readNew()).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });
});
