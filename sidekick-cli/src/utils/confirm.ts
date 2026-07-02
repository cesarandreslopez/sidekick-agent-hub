/**
 * Interactive y/N confirmation for destructive CLI actions.
 * Prompts on stderr so stdout stays clean for piped/--json output.
 * Defaults to No: only an explicit y/yes answer confirms.
 */

import { createInterface } from 'node:readline/promises';

export interface ConfirmStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function confirmDestructive(
  question: string,
  streams: ConfirmStreams = {},
): Promise<boolean> {
  const rl = createInterface({
    input: streams.input ?? process.stdin,
    output: streams.output ?? process.stderr,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
