import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendErrorHistory, getTopFailingTools, readErrorHistory } from './errorHistory';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('error history', () => {
  it('persists multiple sessions and queries top failing tools for seven days', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-errors-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'error-history.json');
    const rollup = {
      totalFailures: 2,
      byToolCategory: [{ tool: 'Bash', category: 'exit_code' as const, count: 2 }],
      byHourModel: [],
      retryAttempts: 1,
      finishReasons: [{ reason: 'tool-calls', count: 1 }],
    };
    await appendErrorHistory(
      {
        sessionId: 'one',
        providerId: 'claude-code',
        project: 'project',
        endedAt: '2026-07-17T12:00:00Z',
      },
      rollup,
      filePath,
    );
    await appendErrorHistory(
      {
        sessionId: 'two',
        providerId: 'codex',
        project: 'project',
        endedAt: '2026-07-18T12:00:00Z',
      },
      rollup,
      filePath,
    );

    expect((await readErrorHistory(filePath)).sessions).toHaveLength(2);
    expect(await getTopFailingTools(7, new Date('2026-07-18T18:00:00Z'), filePath)).toEqual([
      { tool: 'Bash', failures: 4, categories: { exit_code: 4 } },
    ]);
  });
});
