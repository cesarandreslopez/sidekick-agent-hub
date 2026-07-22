import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';

const temporaryDirectories: string[] = [];

function splitAcrossEmoji(filePath: string, value: unknown): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  const emoji = Buffer.from('😀');
  const emojiOffset = encoded.indexOf(emoji);
  expect(emojiOffset).toBeGreaterThan(0);
  fs.writeFileSync(filePath, encoded.subarray(0, emojiOffset + 2));
  return encoded.subarray(emojiOffset + 2);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('incremental provider readers', () => {
  it('preserves split UTF-8 code points in Claude JSONL events', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-claude-utf8-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'session.jsonl');
    const remainder = splitAcrossEmoji(filePath, {
      type: 'assistant',
      timestamp: '2026-07-21T00:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello 😀' }] },
    });
    const reader = new ClaudeCodeProvider().createReader(filePath);

    expect(reader.readNew()).toEqual([]);
    fs.appendFileSync(filePath, remainder);
    const events = reader.readNew();

    expect(JSON.stringify(events)).toContain('hello 😀');
    expect(JSON.stringify(events)).not.toContain('�');
  });

  it('preserves split UTF-8 code points in Codex rollout metadata', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-utf8-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'rollout.jsonl');
    const remainder = splitAcrossEmoji(filePath, {
      timestamp: '2026-07-21T00:00:00Z',
      type: 'session_meta',
      payload: { id: 'session', cwd: '/workspace/😀', originator: 'codex_cli_rs' },
    });
    const reader = new CodexProvider().createReader(filePath) as ReturnType<
      CodexProvider['createReader']
    > & { getSessionMeta(): { cwd: string } | null };

    expect(reader.readNew()).toEqual([]);
    fs.appendFileSync(filePath, remainder);
    reader.readNew();

    expect(reader.getSessionMeta()?.cwd).toBe('/workspace/😀');
  });
});
