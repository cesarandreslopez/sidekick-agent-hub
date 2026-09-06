import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readSessionTranscript } from '../sessionTranscripts';
import { ClaudeCodeProvider } from './claudeCode';

describe('ClaudeCodeProvider transcript provenance', () => {
  it('preserves direct and progress-wrapped provider provenance through projection', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-provenance-'));
    const sessionPath = path.join(directory, 'session-1.jsonl');
    const provider = new ClaudeCodeProvider();
    const rows = [
      {
        type: 'user',
        timestamp: '2026-07-22T12:00:00.000Z',
        entrypoint: 'cli',
        isMeta: false,
        isSidechain: false,
        cwd: '/workspace/human',
        gitBranch: 'human-branch',
        message: { role: 'user', content: 'Human CLI prompt' },
      },
      {
        type: 'progress',
        entrypoint: 'sdk',
        isMeta: true,
        isSidechain: true,
        cwd: '/workspace/sdk',
        gitBranch: 'sdk-branch',
        data: {
          message: {
            type: 'user',
            timestamp: '2026-07-22T12:00:01.000Z',
            message: { role: 'user', content: 'SDK orchestration prompt' },
          },
        },
      },
    ];
    writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    try {
      const transcript = readSessionTranscript(provider, sessionPath, { fidelity: 'full' });

      expect(transcript).toMatchObject({
        provider: 'claude-code',
        cwd: '/workspace/sdk',
        gitBranch: 'sdk-branch',
        messages: [
          {
            text: 'Human CLI prompt',
            source: {
              provider: 'claude-code',
              source: 'claude-code-jsonl',
              entrypoint: 'cli',
              isMeta: false,
              isSidechain: false,
              originalRole: 'user',
            },
          },
          {
            text: 'SDK orchestration prompt',
            source: {
              provider: 'claude-code',
              source: 'claude-code-jsonl',
              entrypoint: 'sdk',
              isMeta: true,
              isSidechain: true,
              originalRole: 'user',
            },
          },
        ],
      });

      const [human, orchestration] = transcript.messages;
      expect(
        human.source.entrypoint === 'cli' &&
          human.source.isMeta !== true &&
          human.source.isSidechain !== true,
      ).toBe(true);
      expect(
        orchestration.source.entrypoint !== 'cli' ||
          orchestration.source.isMeta === true ||
          orchestration.source.isSidechain === true,
      ).toBe(true);
    } finally {
      provider.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('resumes at a complete line when a UTF-8 character spans writes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-cursor-'));
  const filename = path.join(directory, 'session.jsonl');
  const provider = new ClaudeCodeProvider();
  const line = (text: string) =>
    Buffer.from(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-06T12:00:00Z',
        message: { role: 'user', content: text },
      }) + '\n',
    );
  const first = line('first');
  const second = line('café ☕');
  const split = second.indexOf(Buffer.from('é')) + 1;
  try {
    writeFileSync(filename, Buffer.concat([first, second.subarray(0, split)]));
    const live = provider.createReader(filename);
    expect(live.readNew()).toHaveLength(1);
    expect(live.getPosition()).toBe(first.length);
    const resumed = provider.createReader(filename);
    resumed.seekTo(live.getPosition());
    appendFileSync(filename, second.subarray(split));
    const expected = [{ message: { content: 'café ☕' } }];
    expect(live.readNew()).toMatchObject(expected);
    expect(resumed.readNew()).toMatchObject(expected);
    expect(resumed.getPosition()).toBe(first.length + second.length);
  } finally {
    provider.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
