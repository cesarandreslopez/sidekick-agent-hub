import { describe, expect, it } from 'vitest';
import { checkInteractivePreflight } from './interactivePreflight';

const HINT = 'sidekick dump --format text';

describe('checkInteractivePreflight', () => {
  it('allows a real terminal through', () => {
    expect(
      checkInteractivePreflight({ stdinIsTTY: true, stdoutIsTTY: true }, 'dashboard', HINT),
    ).toBeNull();
  });

  it.each<[string, boolean, boolean, string]>([
    ['piped stdin', false, true, 'stdin is not a TTY'],
    ['piped stdout', true, false, 'stdout is not a TTY'],
    ['both piped', false, false, 'stdin is not a TTY'],
  ])('rejects %s and names which stream failed', (_label, stdin, stdout, expected) => {
    const result = checkInteractivePreflight(
      { stdinIsTTY: stdin, stdoutIsTTY: stdout },
      'dashboard',
      HINT,
    );
    expect(result).not.toBeNull();
    expect(result!.message).toContain(expected);
  });

  it('exits non-zero so scripts can detect the failure', () => {
    // Ink's own error path renders a panel and still exits 0, which is what
    // made this silent.
    const result = checkInteractivePreflight(
      { stdinIsTTY: false, stdoutIsTTY: false },
      'dashboard',
      HINT,
    );
    expect(result!.exitCode).toBe(1);
  });

  it('names the command and offers a working alternative', () => {
    const result = checkInteractivePreflight(
      { stdinIsTTY: false, stdoutIsTTY: true },
      'extract -i',
      'sidekick extract',
    );
    expect(result!.message).toContain('sidekick extract -i needs an interactive terminal');
    expect(result!.message).toContain('Try: sidekick extract');
  });
});
