import { describe, expect, it } from 'vitest';
import {
  createSessionRecordExtractor,
  detachedSuffix,
  SIGNAL_COMMAND_CHARS,
  SIGNAL_OUTPUT_CHARS,
  SIGNAL_TEXT_CHARS,
  type PromptHistorySignal,
  type SessionPromptSignalLimits,
} from './sessionPromptSignals';

const TS = '2026-09-01T10:00:00.000Z';

function codexSignals(
  rows: Array<Record<string, unknown>>,
  limits?: SessionPromptSignalLimits,
): PromptHistorySignal[] {
  const extractor = createSessionRecordExtractor(
    'codex',
    { signals: true, replies: false },
    limits,
  );
  rows.forEach((row, index) => extractor.observe(row, { ordinal: 0, lineOffset: index }));
  return extractor.result().signals;
}

function execEnd(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: TS,
    type: 'event_msg',
    payload: { type: 'exec_command_end', call_id: 'call_1', ...payload },
  };
}

function commandItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: TS,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'CommandExecution', id: 'item_1', ...item },
    },
  };
}

function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

describe('structured tool-error signals', () => {
  it('keeps the head of a long command and the tail of its output', () => {
    const heredoc = `cat <<'EOF' > notes.md\n${'line of text\n'.repeat(420)}EOF`;
    expect(heredoc.length).toBeGreaterThan(5000);
    const output = `${'progress\n'.repeat(500)}error: the build failed at step 9`;
    const [signal] = codexSignals([
      execEnd({
        command: ['/bin/zsh', '-lc', heredoc],
        aggregated_output: output,
        exit_code: 1,
        status: 'failed',
      }),
    ]);

    expect(signal).toMatchObject({
      kind: 'toolError',
      tool: 'exec_command',
      toolUseId: 'call_1',
      exitCode: 1,
      commandTruncated: true,
      outputTruncated: true,
      textTruncated: true,
    });
    expect(signal.command).toBe(heredoc.slice(0, SIGNAL_COMMAND_CHARS));
    expect(signal.output).toBe(output.slice(-SIGNAL_OUTPUT_CHARS));
    // The text shows how the command started and how its output ended.
    expect(signal.text!.length).toBeLessThanOrEqual(SIGNAL_TEXT_CHARS);
    expect(signal.text!.startsWith(`$ ${heredoc.slice(0, 254)} \u2026\n\u2026 `)).toBe(true);
    expect(signal.text!.endsWith('error: the build failed at step 9')).toBe(true);
  });

  it('keeps short commands and outputs whole', () => {
    const [signal] = codexSignals([
      commandItem({
        command: ['/bin/bash', '-c', 'npm test'],
        aggregated_output: 'FAIL src/a.test.ts\n',
        exit_code: 2,
        status: 'failed',
      }),
    ]);
    expect(signal).toEqual({
      kind: 'toolError',
      timestamp: TS,
      afterOrdinal: 0,
      tool: 'exec_command',
      toolCategory: 'shell',
      command: 'npm test',
      output: 'FAIL src/a.test.ts',
      exitCode: 2,
      text: '$ npm test\nFAIL src/a.test.ts',
      toolUseId: 'item_1',
    });
  });

  it('turns a plain argv into the command line, not its last argument', () => {
    const commandOf = (command: unknown) =>
      codexSignals([execEnd({ command, exit_code: 1, status: 'failed' })])[0].command;
    expect(commandOf(['git', 'status'])).toBe('git status');
    expect(commandOf(['rg', '-n', 'two words', "it's"])).toBe(`rg -n 'two words' 'it'\\''s'`);
    expect(commandOf(['sh', '-c', 'echo hi | wc -c'])).toBe('echo hi | wc -c');
    expect(commandOf(['/usr/local/bin/fish', '-c', 'ls'])).toBe('ls');
    expect(commandOf(['pwsh', '-NoProfile', '-Command', 'Get-ChildItem', '-Force'])).toBe(
      'Get-ChildItem -Force',
    );
    expect(commandOf(['C:\\Windows\\System32\\cmd.exe', '/C', 'dir', '/b'])).toBe('dir /b');
    expect(commandOf('make lint')).toBe('make lint');
    expect(commandOf([])).toBeUndefined();
  });

  it('reports a declined command as rejected, not as a failure', () => {
    const signals = codexSignals([
      execEnd({ command: ['bash', '-lc', 'rm -rf build'], exit_code: -1, status: 'declined' }),
      commandItem({ command: ['bash', '-lc', 'git push'], status: 'declined', exit_code: null }),
      {
        timestamp: TS,
        type: 'event_msg',
        payload: { type: 'patch_apply_end', call_id: 'call_p', success: false, status: 'declined' },
      },
    ]);
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'toolRejected',
        tool: 'exec_command',
        command: 'rm -rf build',
        text: '$ rm -rf build',
        toolUseId: 'call_1',
      }),
      expect.objectContaining({
        kind: 'toolRejected',
        command: 'git push',
        toolUseId: 'item_1',
      }),
      expect.objectContaining({ kind: 'toolRejected', tool: 'apply_patch', toolUseId: 'call_p' }),
    ]);
    for (const signal of signals) expect(signal).not.toHaveProperty('exitCode');
  });

  it('keeps the tail of output when no command was recorded', () => {
    const output = `${'x'.repeat(3000)}\nlast line`;
    const [signal] = codexSignals([execEnd({ stderr: output, exit_code: 3 })]);
    expect(signal).not.toHaveProperty('command');
    expect(signal.exitCode).toBe(3);
    expect(signal.output).toBe(output.slice(-SIGNAL_OUTPUT_CHARS));
    expect(signal.text!.startsWith('\u2026 ')).toBe(true);
    expect(signal.text!.endsWith('last line')).toBe(true);
    expect(signal.text!.length).toBeLessThanOrEqual(SIGNAL_TEXT_CHARS);
  });

  it('caps every text field at maxBytes without splitting a code point', () => {
    const command = `echo ${'漢字'.repeat(400)}`;
    const output = `${'😀ok'.repeat(400)}終わり`;
    const [signal] = codexSignals(
      [execEnd({ command: ['zsh', '-lc', command], aggregated_output: output, exit_code: 1 })],
      { maxBytes: 301 },
    );
    for (const field of ['text', 'command', 'output'] as const) {
      const value = signal[field]!;
      expect(utf8(value), field).toBeLessThanOrEqual(301);
      expect(utf8(value), field).toBeGreaterThan(290);
      // Re-encoding would turn a split character into U+FFFD.
      expect(value).not.toContain('\uFFFD');
      expect(Buffer.from(value, 'utf8').toString('utf8')).toBe(value);
    }
    expect(command.startsWith(signal.command!)).toBe(true);
    expect(output.endsWith(signal.output!)).toBe(true);
    expect(signal).toMatchObject({
      commandTruncated: true,
      outputTruncated: true,
      textTruncated: true,
    });
  });

  it('never ends a cut between the halves of a surrogate pair', () => {
    const limits = { commandChars: 6, outputChars: 6, textChars: 40 };
    const [signal] = codexSignals(
      [
        execEnd({
          // Characters 6–7 are one emoji: a 6-unit head must stop before it.
          command: ['bash', '-lc', 'abcde😀fgh'],
          // The last 6 units start inside an emoji: the tail skips its low half.
          aggregated_output: 'start😀abcde',
          exit_code: 1,
        }),
      ],
      limits,
    );
    expect(signal.command).toBe('abcde');
    expect(signal.output).toBe('abcde');
    expect(detachedSuffix('x😀', 1)).toBe('');
    expect(detachedSuffix('x😀', 2)).toBe('😀');
    expect(detachedSuffix('short', 10)).toBe('short');
  });

  it('caps Claude rejection reasons only when maxBytes is set, and records tool_use ids', () => {
    const reason = 'é'.repeat(2000);
    const rows = [
      {
        type: 'assistant',
        timestamp: TS,
        message: {
          id: 'msg_1',
          model: 'claude-test',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'user',
        timestamp: TS,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: `The user doesn't want to proceed with this tool use. the user said: ${reason}`,
            },
          ],
        },
      },
    ];
    const run = (limits?: SessionPromptSignalLimits) => {
      const extractor = createSessionRecordExtractor(
        'claude-code',
        { signals: true, replies: false },
        limits,
      );
      rows.forEach((row, index) => extractor.observe(row, { ordinal: 0, lineOffset: index }));
      return extractor.result().signals[0];
    };
    expect(run()).toMatchObject({ kind: 'toolRejected', toolUseId: 'toolu_1', text: reason });
    const capped = run({ maxBytes: 101 });
    expect(capped.text).toBe('é'.repeat(50));
    expect(capped.textTruncated).toBe(true);
  });
});
