import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HUMAN_CLAUDE_ENTRYPOINTS, humanPromptText, isHumanPrompt } from './humanPrompt';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { readSessionTranscript } from './sessionTranscripts';
import type { CanonicalTranscriptBlock, CanonicalTranscriptMessage } from './transcript';

function message(
  content: CanonicalTranscriptBlock[] | string,
  source: Partial<CanonicalTranscriptMessage['source']> = {},
): CanonicalTranscriptMessage {
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  return {
    role: 'user',
    timestamp: '2026-09-01T10:00:00.000Z',
    content: blocks,
    text: blocks.map((block) => block.text ?? '').join('\n'),
    tools: [],
    commands: [],
    source: {
      originalRole: 'user',
      entrypoint: 'cli',
      eventIndex: 0,
      eventType: 'user',
      ...source,
    },
  };
}

describe('isHumanPrompt — Claude Code', () => {
  it('accepts typed prompts from interactive entrypoints', () => {
    expect(HUMAN_CLAUDE_ENTRYPOINTS).toEqual(['cli', 'claude-desktop', 'sdk-cli']);
    for (const entrypoint of HUMAN_CLAUDE_ENTRYPOINTS) {
      expect(isHumanPrompt(message('fix the bug', { entrypoint }), 'claude-code')).toBe(true);
    }
    expect(
      isHumanPrompt(
        message('typed', { originKind: 'human', promptSource: 'typed' }),
        'claude-code',
      ),
    ).toBe(true);
  });

  it('rejects SDK programs, metadata, sidechains, and non-human origins', () => {
    const rejected: Array<Partial<CanonicalTranscriptMessage['source']>> = [
      { entrypoint: 'sdk-ts' },
      { entrypoint: 'sdk-py' },
      { entrypoint: undefined },
      { isMeta: true },
      { isSidechain: true },
      { isCompactSummary: true },
      { originKind: 'task-notification' },
      { originKind: 'coordinator' },
      { promptSource: 'system' },
      { originalRole: 'assistant' },
    ];
    for (const source of rejected) {
      expect(isHumanPrompt(message('text', source), 'claude-code')).toBe(false);
    }
  });

  it('rejects harness output and tool-result-only lines', () => {
    for (const text of [
      '<local-command-stdout>Set model</local-command-stdout>',
      '<local-command-caveat>Caveat: the messages below…</local-command-caveat>',
      '<task-notification><task-id>1</task-id></task-notification>',
      '<system-reminder>x</system-reminder>',
      '[Request interrupted by user]',
      'This session is being continued from a previous conversation that ran out of context.',
      '   ',
    ]) {
      expect(isHumanPrompt(message(text), 'claude-code')).toBe(false);
    }
    expect(isHumanPrompt(message([{ type: 'tool_result' }]), 'claude-code')).toBe(false);
    expect(isHumanPrompt(message([{ type: 'image' }]), 'claude-code')).toBe(false);
  });

  it('returns slash commands as typed, in both recorded tag orders', () => {
    const modern =
      '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>foo bar</command-args>';
    const legacy =
      '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
    expect(humanPromptText(message(modern), 'claude-code')).toBe('/review foo bar');
    expect(humanPromptText(message(legacy), 'claude-code')).toBe('/clear');
  });

  it('keeps full text without truncation', () => {
    const long = 'x'.repeat(10_000);
    expect(humanPromptText(message(long), 'claude-code')).toBe(long);
  });
});

describe('isHumanPrompt — Codex', () => {
  it('keeps typed text and drops injected blocks and image wrappers', () => {
    const typed = message(
      [
        { type: 'text', text: '<image name=[Image #1]>' },
        { type: 'image' },
        { type: 'text', text: '</image>' },
        { type: 'text', text: '[Image #1] why is this red?' },
      ],
      { entrypoint: undefined },
    );
    expect(humanPromptText(typed, 'codex')).toBe('[Image #1] why is this red?');
  });

  it('rejects injected context, instructions, and non-user roles', () => {
    for (const text of [
      '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>…',
      '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>',
      '<user_instructions>be terse</user_instructions>',
      '<turn_aborted>',
      '<codex_internal_context source="goal">keep going</codex_internal_context>',
      '<subagent_notification>done</subagent_notification>',
      '<skill>…</skill>',
    ]) {
      expect(isHumanPrompt(message(text, { entrypoint: undefined }), 'codex')).toBe(false);
    }
    expect(isHumanPrompt(message('hi', { originalRole: 'developer' }), 'codex')).toBe(false);
  });
});

describe('isHumanPrompt on readSessionTranscript output', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-human-prompt-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the Claude provenance carried through the canonical transcript', () => {
    const base = { entrypoint: 'cli', cwd: '/repo', sessionId: 's1' };
    const rows = [
      {
        ...base,
        type: 'user',
        timestamp: '2026-09-01T10:00:00.000Z',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: { role: 'user', content: [{ type: 'text', text: 'real prompt' }] },
      },
      {
        ...base,
        type: 'user',
        timestamp: '2026-09-01T10:00:01.000Z',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'background task finished' },
      },
      {
        ...base,
        type: 'user',
        timestamp: '2026-09-01T10:00:02.000Z',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: 'user', content: 'Summary of the earlier conversation' },
      },
    ];
    const file = path.join(tmpDir, 's1.jsonl');
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const transcript = readSessionTranscript(new ClaudeCodeProvider(), file, { fidelity: 'full' });
    const users = transcript.messages.filter((m) => m.role === 'user');
    expect(users.map((m) => m.source.originKind)).toEqual([
      'human',
      'task-notification',
      undefined,
    ]);
    expect(users[2].source.isCompactSummary).toBe(true);
    expect(users[0].source.promptSource).toBe('typed');
    expect(
      transcript.messages.filter((m) => isHumanPrompt(m, 'claude-code')).map((m) => m.text),
    ).toEqual(['real prompt']);
  });
});
