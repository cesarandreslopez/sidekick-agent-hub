/**
 * Tests for the destructive-action confirmation prompt.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { confirmDestructive } from './confirm';

function ask(answer: string): Promise<boolean> {
  const input = new PassThrough();
  const output = new PassThrough();
  const result = confirmDestructive('Remove account?', { input, output });
  input.write(answer);
  input.end();
  return result;
}

describe('confirmDestructive', () => {
  it("accepts 'y' and 'yes' in any case with surrounding whitespace", async () => {
    await expect(ask('y\n')).resolves.toBe(true);
    await expect(ask('yes\n')).resolves.toBe(true);
    await expect(ask(' Y \n')).resolves.toBe(true);
    await expect(ask('YES\n')).resolves.toBe(true);
  });

  it('defaults to No on empty or unrecognized input', async () => {
    await expect(ask('\n')).resolves.toBe(false);
    await expect(ask('n\n')).resolves.toBe(false);
    await expect(ask('whatever\n')).resolves.toBe(false);
    await expect(ask('yep\n')).resolves.toBe(false);
  });

  it('writes the prompt with a [y/N] suffix to the output stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = confirmDestructive('Delete it?', { input, output });
    input.write('n\n');
    input.end();
    await pending;
    expect(output.read()?.toString()).toContain('Delete it? [y/N]');
  });
});
