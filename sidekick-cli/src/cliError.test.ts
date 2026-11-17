import { describe, expect, it } from 'vitest';
import { formatCliError } from './cliError';

describe('formatCliError', () => {
  it('renders rejected async actions as a single clean line', () => {
    const output = formatCliError(new Error('Task not found: missing'));
    expect(output).toBe('Error: Task not found: missing\n');
    expect(output).not.toContain(' at ');
  });

  it('points an unknown session at the command that lists them', () => {
    expect(formatCliError(new Error('Session nope not found. Available: a, b'))).toContain(
      'sidekick dump --list',
    );
  });

  it('names both ways to configure a handoff target', () => {
    const output = formatCliError(new Error('No handoff URL template is configured.'));
    expect(output).toContain('--url-template');
    expect(output).toContain('SIDEKICK_HANDOFF_URL_TEMPLATE');
  });

  it('says an --output-file folder is missing instead of quoting ENOENT', () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/x/y.txt'"), {
      code: 'ENOENT',
      syscall: 'open',
      path: '/x/y.txt',
    });
    expect(formatCliError(error)).toBe(
      'Error: cannot write /x/y.txt: its folder does not exist.\n',
    );
  });
});
