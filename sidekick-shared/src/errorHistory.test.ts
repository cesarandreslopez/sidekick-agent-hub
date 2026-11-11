import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendErrorHistory,
  getTopFailingTools,
  MAX_ERROR_HISTORY_SESSIONS,
  readErrorHistory,
  type ErrorHistoryStore,
} from './errorHistory';

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

  it('keeps one record per session, the latest, and counts each session once', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-errors-dedupe-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'error-history.json');
    const rollup = (count: number) => ({
      totalFailures: count,
      byToolCategory: [{ tool: 'Bash', category: 'exit_code' as const, count }],
      byHourModel: [],
      retryAttempts: 0,
      finishReasons: [],
    });
    const end = (sessionId: string, endedAt: string, count: number) =>
      appendErrorHistory(
        { sessionId, providerId: 'claude-code', project: 'project', endedAt },
        rollup(count),
        filePath,
      );
    // A monitor ends the same session again whenever it switches back to it;
    // each record holds the session's whole rollup so far.
    await end('one', '2026-07-18T10:00:00Z', 1);
    await end('two', '2026-07-18T10:30:00Z', 5);
    await end('one', '2026-07-18T11:00:00Z', 2);
    await end('one', '2026-07-18T12:00:00Z', 3);

    const { sessions } = await readErrorHistory(filePath);
    expect(sessions.map((s) => [s.sessionId, s.endedAt])).toEqual([
      ['two', '2026-07-18T10:30:00Z'],
      ['one', '2026-07-18T12:00:00Z'],
    ]);
    expect(await getTopFailingTools(7, new Date('2026-07-18T18:00:00Z'), filePath)).toEqual([
      { tool: 'Bash', failures: 8, categories: { exit_code: 8 } },
    ]);
  });

  it('counts each session once in a store written with repeated records', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-errors-legacy-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'error-history.json');
    const record = (sessionId: string, providerId: string, count: number) => ({
      sessionId,
      providerId,
      project: 'project',
      endedAt: '2026-07-18T12:00:00Z',
      failures: [{ tool: 'Bash', category: 'exit_code' as const, count }],
      retryAttempts: 0,
      finishReasons: [],
    });
    const legacy: ErrorHistoryStore = {
      schemaVersion: 1,
      // The same id under two providers is two sessions.
      sessions: [
        record('one', 'claude-code', 1),
        record('one', 'claude-code', 4),
        record('one', 'codex', 2),
      ],
      lastSaved: '2026-07-18T12:00:00Z',
    };
    await fs.promises.writeFile(filePath, JSON.stringify(legacy));
    expect(await getTopFailingTools(7, new Date('2026-07-18T18:00:00Z'), filePath)).toEqual([
      { tool: 'Bash', failures: 6, categories: { exit_code: 6 } },
    ]);
  });

  it('keeps only the newest bounded session history', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-errors-cap-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'error-history.json');
    const baseRecord = {
      providerId: 'codex',
      project: 'project',
      endedAt: '2026-07-18T12:00:00Z',
      failures: [],
      retryAttempts: 0,
      finishReasons: [],
    };
    const initial: ErrorHistoryStore = {
      schemaVersion: 1,
      sessions: Array.from({ length: MAX_ERROR_HISTORY_SESSIONS }, (_, index) => ({
        ...baseRecord,
        sessionId: `session-${index}`,
      })),
      lastSaved: baseRecord.endedAt,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(initial));

    await appendErrorHistory(
      { sessionId: 'newest', providerId: 'codex', project: 'project' },
      {
        totalFailures: 0,
        byToolCategory: [],
        byHourModel: [],
        retryAttempts: 0,
        finishReasons: [],
      },
      filePath,
    );

    const sessions = (await readErrorHistory(filePath)).sessions;
    expect(sessions).toHaveLength(MAX_ERROR_HISTORY_SESSIONS);
    expect(sessions[0].sessionId).toBe('session-1');
    expect(sessions.at(-1)?.sessionId).toBe('newest');
  });
});
