import { describe, expect, it } from 'vitest';
import { formatCliError } from './cliError';

describe('formatCliError', () => {
  it('renders rejected async actions as a single clean line', () => {
    const output = formatCliError(new Error('Task not found: missing'));
    expect(output).toBe('Error: Task not found: missing\n');
    expect(output).not.toContain(' at ');
  });
});
