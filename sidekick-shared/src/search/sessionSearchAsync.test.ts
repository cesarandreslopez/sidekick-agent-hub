/**
 * `searchInSessionAsync` streams a session in chunks and must return what
 * `searchInSession` returns; `searchSessions` prefers it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import { __compressedRolloutTesting } from '../providers/compressedRollouts';
import type { SessionProviderBase } from '../providers/types';
import { searchSessions } from './sessionSearch';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-search-async-'));
});

afterEach(() => {
  __compressedRolloutTesting.setDecompress(undefined);
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const claudeUser = (text: string, i: number) =>
  JSON.stringify({
    type: 'user',
    timestamp: `2026-09-04T12:00:${String(i % 60).padStart(2, '0')}Z`,
    message: { role: 'user', content: text },
  });

function claudeFile(lines: string[], trailingNewline = true): string {
  const project = path.join(dir, 'projects', '-work-proj');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'session-1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

const CLAUDE_LINES = [
  claudeUser('the needle is here — ünï 🚀', 1),
  '{"type":"user","message": broken needle json',
  claudeUser(`${'x'.repeat(100)} NEEDLE again ${'y'.repeat(100)}`, 2),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-04T12:00:03Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'a needle\nacross lines' }] },
  }),
  claudeUser('no match', 4),
  // Matches the raw line but not the searchable text.
  JSON.stringify({
    type: 'user',
    timestamp: 't',
    note: 'needle',
    message: { role: 'user', content: 'x' },
  }),
  claudeUser('last needle', 5),
];

describe('ClaudeCodeProvider.searchInSessionAsync', () => {
  const claude = new ClaudeCodeProvider();

  it('returns the synchronous hits, final line without newline included', async () => {
    const file = claudeFile(CLAUDE_LINES, false);
    const expected = claude.searchInSession(file, 'needle', 50);
    expect(expected).toHaveLength(4);
    expect(await claude.searchInSessionAsync(file, 'needle', 50)).toEqual(expected);
  });

  it('stops at maxResults', async () => {
    const file = claudeFile(CLAUDE_LINES);
    for (const max of [0, 1, 2, 3]) {
      expect(await claude.searchInSessionAsync(file, 'needle', max)).toEqual(
        claude.searchInSession(file, 'needle', max),
      );
    }
  });

  it('returns no hits for an unreadable file', async () => {
    expect(await claude.searchInSessionAsync(path.join(dir, 'missing.jsonl'), 'x', 5)).toEqual([]);
  });

  it('resolves with the hits so far when aborted mid-file', async () => {
    // ~3 MB: several 1 MiB chunks, a match on every line.
    const lines = Array.from({ length: 3000 }, (_, i) =>
      claudeUser(`needle ${i} ${'p'.repeat(1000)}`, i),
    );
    const file = claudeFile(lines);
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    const hits = await claude.searchInSessionAsync(file, 'needle', 10_000, {
      signal: controller.signal,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(3000);
  });
});

const codexLine = (row: unknown) => JSON.stringify(row);
const CODEX_LINES = [
  codexLine({
    type: 'session_meta',
    timestamp: '2026-09-04T12:00:00Z',
    payload: { id: 'cx', cwd: '/work/codex' },
  }),
  codexLine({
    type: 'response_item',
    timestamp: '2026-09-04T12:00:01Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'find the needle ✓' }],
    },
  }),
  '{"type":"response_item" needle broken',
  codexLine({
    type: 'response_item',
    timestamp: '2026-09-04T12:00:02Z',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"grep needle"}' },
  }),
  codexLine({
    type: 'response_item',
    timestamp: '2026-09-04T12:00:03Z',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'last needle' }],
    },
  }),
];

describe('CodexProvider.searchInSessionAsync', () => {
  const codex = new CodexProvider();

  function rollout(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('returns the synchronous hits, with the session cwd as project', async () => {
    const file = rollout('rollout-2026-09-04T12-00-00-cx.jsonl', CODEX_LINES.join('\n'));
    const expected = codex.searchInSession(file, 'needle', 50);
    expect(expected).toHaveLength(3);
    expect(expected[0].projectPath).toBe('/work/codex');
    expect(await codex.searchInSessionAsync(file, 'needle', 50)).toEqual(expected);
    for (const max of [0, 1, 2]) {
      expect(await codex.searchInSessionAsync(file, 'needle', max)).toEqual(
        codex.searchInSession(file, 'needle', max),
      );
    }
  });

  it('reads a compressed rollout', async () => {
    // An identity "decompressor" reads a plain file, on any Node version.
    __compressedRolloutTesting.setDecompress((input) => input);
    const file = rollout('rollout-2026-09-04T12-00-00-cz.jsonl.zst', CODEX_LINES.join('\n') + '\n');
    const expected = codex.searchInSession(file, 'needle', 50);
    expect(expected).toHaveLength(3);
    expect(await codex.searchInSessionAsync(file, 'needle', 50)).toEqual(expected);
  });

  it('returns no hits for a missing rollout', async () => {
    expect(await codex.searchInSessionAsync(path.join(dir, 'missing.jsonl'), 'needle', 5)).toEqual(
      [],
    );
  });
});

describe('searchSessions', () => {
  it('prefers the streaming search when the provider has it', async () => {
    const claude = new ClaudeCodeProvider();
    const file = claudeFile(CLAUDE_LINES);
    vi.spyOn(claude, 'listSessionFilesAsync').mockResolvedValue([
      { path: file, mtime: new Date(), workspacePath: '/work/proj' },
    ]);
    const sync = vi.spyOn(claude, 'searchInSession');
    const async = vi.spyOn(claude, 'searchInSessionAsync');
    const controller = new AbortController();
    const results = await searchSessions(claude, 'needle', {
      maxResults: 3,
      projectPath: dir,
      signal: controller.signal,
    });
    expect(sync).not.toHaveBeenCalled();
    expect(async).toHaveBeenCalledWith(file, 'needle', 3, { signal: controller.signal });
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ providerId: 'claude-code', sessionPath: file });
  });

  it('falls back to the synchronous search', async () => {
    const claude = new ClaudeCodeProvider();
    const file = claudeFile(CLAUDE_LINES);
    // A provider without the optional streaming method.
    const provider = {
      id: 'claude-code',
      listSessionFilesAsync: async () => [{ path: file, mtime: new Date(), workspacePath: '/w' }],
      searchInSession: (p: string, q: string, max: number) => claude.searchInSession(p, q, max),
    } as unknown as SessionProviderBase;
    const results = await searchSessions(provider, 'needle', { projectPath: dir });
    expect(results).toHaveLength(4);
    expect(results.map((result) => result.snippet)).toEqual(
      claude.searchInSession(file, 'needle', 50).map((hit) => hit.line),
    );
  });
});

describe('searchInSessionAsync read errors', () => {
  it('keeps the hits found before a read fails partway through a file', async () => {
    const filler = Array.from({ length: 600 }, (_, i) => claudeUser(`${i} ${'z'.repeat(3000)}`, i));
    const file = claudeFile([
      claudeUser('early needle', 1),
      ...filler,
      claudeUser('late needle', 2),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);
    const originalOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...(args as Parameters<typeof originalOpen>));
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      let reads = 0;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        reads += 1;
        if (reads > 1) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
        return read(...a);
      };
      return handle;
    });
    const hits = await new ClaudeCodeProvider().searchInSessionAsync(file, 'needle', 10);
    expect(hits.map((hit) => hit.line)).toEqual([expect.stringContaining('early needle')]);
  });
});
