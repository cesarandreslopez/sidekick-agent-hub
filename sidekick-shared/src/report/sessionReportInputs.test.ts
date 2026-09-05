import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'config'),
}));

import { ClaudeCodeProvider } from '../providers/claudeCode';
import type { SessionProviderBase } from '../providers/types';
import { resolveSessionPath } from '../watchers/factory';
import { readSessionReportInputs } from './sessionReportInputs';

const MODEL = 'claude-sonnet-4-5-20250929';

describe('readSessionReportInputs', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-report-inputs-'));
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('derives metrics and the report transcript from one flushed read', () => {
    const sessionPath = path.join(tmpDir, 'session-report.jsonl');
    const rows = [
      {
        type: 'user',
        timestamp: '2026-09-04T12:00:00.000Z',
        message: { role: 'user', content: 'Explain the build' },
      },
      {
        type: 'assistant',
        timestamp: '2026-09-04T12:00:05.000Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: MODEL,
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
          content: [
            { type: 'text', text: 'It uses esbuild.' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'esbuild.js' } },
          ],
        },
      },
    ];
    // No trailing newline: the last row only arrives on flush().
    fs.writeFileSync(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n'));
    const createReader = vi.spyOn(provider, 'createReader');

    const inputs = readSessionReportInputs(provider, sessionPath);

    expect(createReader).toHaveBeenCalledTimes(1);
    expect(inputs.events).toHaveLength(2);
    expect(inputs.metrics.messageCount).toBe(2);
    expect(inputs.metrics.tokens.inputTokens).toBe(100);
    expect(inputs.metrics.tokens.cacheReadTokens).toBe(40);
    expect(inputs.metrics.toolStats.map((tool) => tool.name)).toEqual(['Read']);
    expect(inputs.transcript.map((entry) => entry.type)).toEqual(['user', 'assistant']);
    expect(inputs.transcript[1].usage).toMatchObject({ input_tokens: 100, output_tokens: 10 });
  });
});

describe('resolveSessionPath', () => {
  const provider = {
    displayName: 'Fake',
    findAllSessions: () => ['/s/abc-123.jsonl', '/s/abd-456.jsonl', '/s/zzz-789.jsonl'],
    getSessionId: (sessionPath: string) => path.basename(sessionPath, '.jsonl'),
  } as unknown as SessionProviderBase;

  it('returns the most recent session, an exact match, or a unique prefix match', () => {
    expect(resolveSessionPath(provider, '/work')).toBe('/s/abc-123.jsonl');
    expect(resolveSessionPath(provider, '/work', 'abd-456')).toBe('/s/abd-456.jsonl');
    expect(resolveSessionPath(provider, '/work', 'zz')).toBe('/s/zzz-789.jsonl');
  });

  it('explains misses and ambiguity', () => {
    expect(() => resolveSessionPath(provider, '/work', 'nope')).toThrow(/not found/);
    expect(() => resolveSessionPath(provider, '/work', 'ab')).toThrow(/ambiguous/);
    const empty = { ...provider, findAllSessions: () => [] } as unknown as SessionProviderBase;
    expect(() => resolveSessionPath(empty, '/work')).toThrow(/No sessions found/);
  });
});
