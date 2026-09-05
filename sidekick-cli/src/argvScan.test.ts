import { describe, expect, it } from 'vitest';
import { firstCommandToken, isStatuslineInvocation } from './argvScan';

describe('firstCommandToken', () => {
  it.each<[string, string[], string | undefined]>([
    ['bare invocation', [], undefined],
    ['global boolean only', ['--json'], undefined],
    ['color opt-out only', ['--no-color'], undefined],
    ['help', ['--help'], '--help'],
    ['version', ['--version'], '--version'],
    ['plain command', ['statusline'], 'statusline'],
    ['boolean before command', ['--json', 'statusline'], 'statusline'],
    ['color opt-out before command', ['--no-color', 'tasks'], 'tasks'],
    ['separated value flag', ['--project', '/x', 'dashboard'], 'dashboard'],
    ['inline value flag', ['--project=/x', 'dashboard'], 'dashboard'],
    ['provider value flag', ['--provider', 'codex', 'stats'], 'stats'],
    ['several globals', ['--json', '--project', '/x', '--no-color', 'quota'], 'quota'],
    ['offline before command', ['--offline', 'stats'], 'stats'],
    ['output file before command', ['--output-file', 'out.txt', 'stats'], 'stats'],
    ['inline output file', ['--output-file=out.txt', 'stats'], 'stats'],
  ])('resolves %s', (_label, args, expected) => {
    expect(firstCommandToken(args)).toBe(expected);
  });

  it('does not mistake a subcommand argument for the command', () => {
    // `today` is also a top-level command; it must not win here.
    expect(firstCommandToken(['tasks', 'add', 'today'])).toBe('tasks');
  });

  it('does not mistake an option value for the command', () => {
    // A project path that happens to name a command is still a value.
    expect(firstCommandToken(['--project', 'dashboard', 'stats'])).toBe('stats');
  });
});

describe('isStatuslineInvocation', () => {
  it('matches the fast-path invocations entry.ts must catch', () => {
    expect(isStatuslineInvocation(['statusline'])).toBe(true);
    expect(isStatuslineInvocation(['--json', 'statusline'])).toBe(true);
    expect(isStatuslineInvocation(['--project=/x', 'statusline'])).toBe(true);
    expect(isStatuslineInvocation(['--offline', 'statusline'])).toBe(true);
  });

  it('does not match anything else', () => {
    expect(isStatuslineInvocation([])).toBe(false);
    expect(isStatuslineInvocation(['--help'])).toBe(false);
    expect(isStatuslineInvocation(['dashboard'])).toBe(false);
    expect(isStatuslineInvocation(['--provider', 'statusline', 'stats'])).toBe(false);
  });
});
