import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeSessionCwdAsync } from './claudeListing';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readClaudeSessionCwdAsync', () => {
  it('keeps a multi-byte cwd intact when it straddles a 64 KiB read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-claude-cwd-'));
    dirs.push(dir);
    const cwd = '/Users/josé/プロジェクト/app';
    const prefix = '{"type":"user","cwd":"';
    // Place the cwd so its first multi-byte character starts one byte before
    // the 64 KiB chunk edge: its continuation bytes land in the next read.
    const firstLineBytes = 64 * 1024 - Buffer.byteLength(prefix + '/Users/jos') - 1 - 1;
    const filler = JSON.stringify({ type: 'summary', text: 'x'.repeat(firstLineBytes - 30) });
    const padded = filler.padEnd(firstLineBytes, ' ');
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, `${padded}\n${prefix}${cwd}"}\n`);
    const edge = 64 * 1024;
    const bytes = fs.readFileSync(file);
    // The byte at the edge is a UTF-8 continuation byte of the cwd.
    expect(bytes[edge] & 0xc0).toBe(0x80);
    await expect(readClaudeSessionCwdAsync(file)).resolves.toBe(cwd);
  });
});
