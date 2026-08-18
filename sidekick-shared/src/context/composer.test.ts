import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectIdentity, setConfigDir, type ProjectIdentity } from '../paths';
import { addTask, completeTask } from '../writers/tasks';
import { addDecision } from '../writers/decisions';
import { addNote } from '../writers/notes';
import type { SessionFileStats, SessionProviderBase } from '../providers/types';
import { composeContext } from './composer';

let configDir: string;
let workspaceDir: string;
let project: ProjectIdentity;

function makeStats(sessionPath: string): SessionFileStats {
  return {
    providerId: 'claude-code',
    sessionId: path.basename(sessionPath, '.jsonl'),
    filePath: sessionPath,
    label: null,
    startTime: '2026-08-18T09:00:00Z',
    endTime: '2026-08-18T10:00:00Z',
    messageCount: 4,
    tokens: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 },
    modelUsage: {},
    toolUsage: {},
    compactionEstimate: 0,
    truncationCount: 0,
    reportedCost: 0,
  };
}

function makeProvider(
  sessions: string[],
  overrides: Record<string, unknown> = {},
): SessionProviderBase {
  return {
    id: 'claude-code',
    displayName: 'fake',
    findAllSessions: () => sessions,
    readSessionStats: (sessionPath: string) => makeStats(sessionPath),
    ...overrides,
  } as unknown as SessionProviderBase;
}

function writeHistory(totalCost: number): void {
  fs.writeFileSync(
    path.join(configDir, 'historical-data.json'),
    JSON.stringify({
      schemaVersion: 3,
      allTime: {
        tokens: { input: 1000, output: 400, cacheWrite: 10, cacheRead: 20 },
        totalCost,
      },
    }),
  );
}

function writeHandoff(content: string): void {
  const handoffDir = path.join(configDir, 'handoffs');
  fs.mkdirSync(handoffDir, { recursive: true });
  fs.writeFileSync(path.join(handoffDir, `${project.canonicalSlug}-latest.md`), content);
}

describe('composeContext', () => {
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-composer-config-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-composer-workspace-'));
    setConfigDir(configDir);
    project = resolveProjectIdentity(workspaceDir);
  });

  afterEach(() => {
    setConfigDir(null);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('returns empty collections for a project with no stores', async () => {
    const result = await composeContext(project, 'full', makeProvider([]));

    expect(result).toMatchObject({
      provider: 'claude-code',
      tasks: { items: [], total: 0 },
      decisions: { items: [], total: 0 },
      notes: { items: [], total: 0 },
      handoff: null,
      stats: null,
      sessionSummaries: [],
    });
  });

  it('full fidelity returns everything with active and needs_review notes', async () => {
    await addTask(workspaceDir, 'pending task');
    const done = await addTask(workspaceDir, 'finished task');
    await completeTask(workspaceDir, done.taskId);
    await addDecision(workspaceDir, 'use vitest', {});
    await addNote(workspaceDir, 'critical note', { importance: 'critical' });
    await addNote(workspaceDir, 'medium note', {});
    writeHistory(12.5);
    writeHandoff('# Handoff\ncontinue here');

    const result = await composeContext(project, 'full', makeProvider([]));

    expect(result.tasks.items).toHaveLength(2);
    expect(result.tasks.total).toBe(2);
    expect(result.decisions.items).toHaveLength(1);
    expect(result.notes.items.map((note) => note.content).sort()).toEqual([
      'critical note',
      'medium note',
    ]);
    expect(result.handoff).toBe('# Handoff\ncontinue here');
    expect(result.stats).toEqual({
      tokens: { input: 1000, output: 400, cacheWrite: 10, cacheRead: 20 },
      cost: 12.5,
    });
  });

  it('compact fidelity keeps pending tasks, ten decisions, and active notes', async () => {
    await addTask(workspaceDir, 'pending task');
    const done = await addTask(workspaceDir, 'finished task');
    await completeTask(workspaceDir, done.taskId);
    for (let index = 0; index < 12; index++) {
      await addDecision(workspaceDir, `decision ${index}`, {});
    }
    writeHistory(3);

    const result = await composeContext(project, 'compact', makeProvider([]));

    expect(result.tasks.items.map((task) => task.subject)).toEqual(['pending task']);
    expect(result.tasks.total).toBe(2);
    expect(result.decisions.items).toHaveLength(10);
    expect(result.decisions.total).toBe(12);
    expect(result.stats?.cost).toBe(3);
  });

  it('brief fidelity keeps three pending tasks, no decisions, critical notes, no stats', async () => {
    for (let index = 0; index < 5; index++) {
      await addTask(workspaceDir, `task ${index}`);
    }
    await addDecision(workspaceDir, 'a decision', {});
    await addNote(workspaceDir, 'critical note', { importance: 'critical' });
    await addNote(workspaceDir, 'medium note', {});
    writeHistory(9);

    const result = await composeContext(project, 'brief', makeProvider([]));

    expect(result.tasks.items).toHaveLength(3);
    expect(result.tasks.total).toBe(5);
    expect(result.decisions.items).toEqual([]);
    expect(result.decisions.total).toBe(1);
    expect(result.notes.items.map((note) => note.content)).toEqual(['critical note']);
    expect(result.stats).toBeNull();
  });

  it('caps session summaries by fidelity and skips sessions whose stats throw', async () => {
    const sessions = Array.from({ length: 4 }, (_, index) => `/sessions/s-${index}.jsonl`);
    const provider = makeProvider(sessions, {
      readSessionStats: (sessionPath: string) => {
        if (sessionPath.includes('s-1')) throw new Error('corrupt');
        return makeStats(sessionPath);
      },
    });

    const brief = await composeContext(project, 'brief', makeProvider(sessions), workspaceDir);
    expect(brief.sessionSummaries).toHaveLength(1);

    const full = await composeContext(project, 'full', provider, workspaceDir);
    // Fidelity 'full' reads up to five sessions; one of the four throws.
    expect(full.sessionSummaries.map((stats) => stats.sessionId)).toEqual(['s-0', 's-2', 's-3']);

    const noWorkspace = await composeContext(project, 'full', provider);
    expect(noWorkspace.sessionSummaries).toEqual([]);
  });
});
