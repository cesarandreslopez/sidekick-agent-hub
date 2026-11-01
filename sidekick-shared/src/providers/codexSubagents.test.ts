import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { CodexDbThread } from '../types/codex';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

interface FakeDbState {
  threads: CodexDbThread[];
}
const fakeDb = vi.hoisted(() => ({ state: null as FakeDbState | null }));

vi.mock('./codexDatabase', async () => {
  const actual = await vi.importActual<typeof import('./codexDatabase')>('./codexDatabase');
  class FakeCodexDatabase {
    isAvailable(): boolean {
      return fakeDb.state !== null;
    }
    open(): boolean {
      return fakeDb.state !== null;
    }
    getRuntimeStatus() {
      return fakeDb.state
        ? { available: true, kind: 'available' as const }
        : { available: false, kind: 'db_missing' as const };
    }
    close(): void {}
    getThread(id: string): CodexDbThread | null {
      return fakeDb.state?.threads.find((thread) => thread.id === id) ?? null;
    }
    getThreadsByCwd(): CodexDbThread[] {
      return [...(fakeDb.state?.threads ?? [])].sort((a, b) => b.updated_at - a.updated_at);
    }
    getMostRecentThread(): CodexDbThread | null {
      return this.getThreadsByCwd().find((thread) => !actual.isCodexSubagentThread(thread)) ?? null;
    }
    getThreadsByForkedFromId(): CodexDbThread[] {
      return [];
    }
    getSpawnedDescendantThreads(rootId: string) {
      const found: Array<{ thread: CodexDbThread; parentId: string; depth: number }> = [];
      let level = [rootId];
      for (let depth = 1; level.length > 0; depth++) {
        const next: string[] = [];
        for (const thread of fakeDb.state?.threads ?? []) {
          const parentId = actual.spawnParentFromSource(thread.source);
          if (parentId && level.includes(parentId)) {
            found.push({ thread, parentId, depth });
            next.push(thread.id);
          }
        }
        level = next;
      }
      return found;
    }
    getAllDistinctCwds() {
      return [];
    }
    getDbMtime(): number {
      return 0;
    }
  }
  return { ...actual, CodexDatabase: FakeCodexDatabase };
});

import { clearSubagentStatsCache } from '../parsers/subagentStatsCache';
import {
  CALL_SPAWN,
  CALL_SPAWN_GRANDCHILD,
  CHILD_ID,
  CHILD_PATH,
  GRANDCHILD_ID,
  GRANDCHILD_PATH,
  PARENT_ID,
  at,
  childRollout,
  grandchildRollout,
  parentRollout,
  toJsonl,
  type CodexFixtureRow,
} from '../testing/codexSubagentFixtures';
import { CodexProvider } from './codex';
import { clearCodexSpawnLinkCache } from './codexSubagents';

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
const CWD = '/work/repo';

let codexHome: string;
let savedCodexHome: string | undefined;

function rolloutPath(id: string, minute: number): string {
  return path.join(
    codexHome,
    'sessions',
    '2026',
    '10',
    '30',
    `rollout-2026-10-30T20-${String(minute).padStart(2, '0')}-00-${id}.jsonl`,
  );
}

function write(file: string, rows: CodexFixtureRow[], mtime: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toJsonl(rows));
  fs.utimesSync(file, mtime, mtime);
}

/** Replaces `file` by its compressed copy `file.zst`, as Codex does. */
function compress(file: string): string {
  const compressed = `${file}.zst`;
  const compressSync = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer })
    .zstdCompressSync;
  fs.writeFileSync(compressed, compressSync(fs.readFileSync(file)));
  const { mtime } = fs.statSync(file);
  fs.utimesSync(compressed, mtime, mtime);
  fs.rmSync(file);
  return compressed;
}

function thread(id: string, file: string, extra: Partial<CodexDbThread> = {}): CodexDbThread {
  return {
    id,
    rollout_path: file,
    cwd: CWD,
    created_at: 0,
    updated_at: 0,
    title: '',
    source: 'vscode',
    ...extra,
  };
}

function spawnSource(parent: string, depth: number, agentPath: string, nickname: string): string {
  return JSON.stringify({
    subagent: {
      thread_spawn: {
        parent_thread_id: parent,
        depth,
        agent_path: agentPath,
        agent_nickname: nickname,
        agent_role: null,
      },
    },
  });
}

interface Tree {
  parent: string;
  child: string;
  grandchild: string;
}

function writeTree(options: { withoutActivity?: boolean } = {}): Tree {
  const tree = {
    parent: rolloutPath(PARENT_ID, 15),
    child: rolloutPath(CHILD_ID, 40),
    grandchild: rolloutPath(GRANDCHILD_ID, 41),
  };
  write(tree.parent, parentRollout({ cwd: CWD, ...options }), new Date('2026-10-31T01:46:05Z'));
  write(tree.child, childRollout({ cwd: CWD }), new Date('2026-10-31T01:47:00Z'));
  write(tree.grandchild, grandchildRollout({ cwd: CWD }), new Date('2026-10-31T01:48:00Z'));
  return tree;
}

function useDatabase(tree: Tree): void {
  fakeDb.state = {
    threads: [
      thread(PARENT_ID, tree.parent, { created_at: 1, updated_at: 10, thread_source: 'user' }),
      thread(CHILD_ID, tree.child, {
        created_at: 2,
        updated_at: 20,
        source: spawnSource(PARENT_ID, 1, CHILD_PATH, 'Banach'),
        agent_nickname: 'Banach',
        agent_path: CHILD_PATH,
        thread_source: 'subagent',
      }),
      thread(GRANDCHILD_ID, tree.grandchild, {
        created_at: 3,
        updated_at: 30,
        source: spawnSource(CHILD_ID, 2, GRANDCHILD_PATH, 'Noether'),
        agent_nickname: 'Noether',
        agent_role: 'explorer',
        thread_source: 'subagent',
      }),
    ],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-subagents-'));
  codexHome = path.join(tmpDir, 'codex-home');
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  fakeDb.state = null;
  clearSubagentStatsCache();
  clearCodexSpawnLinkCache();
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodexProvider.scanSubagents', () => {
  it('lists children and grandchildren with spawn links and own-record stats', () => {
    const tree = writeTree();
    useDatabase(tree);
    const subagents = new CodexProvider().scanSubagents(path.dirname(tree.parent), PARENT_ID);

    expect(subagents.map((s) => s.agentId)).toEqual([CHILD_ID, GRANDCHILD_ID]);
    const [child, grandchild] = subagents;
    expect(child).toMatchObject({
      agentId: CHILD_ID,
      description: 'Banach',
      filePath: tree.child,
      spawnToolUseId: CALL_SPAWN,
      agentNickname: 'Banach',
      agentPath: CHILD_PATH,
      parentAgentId: PARENT_ID,
      depth: 1,
    });
    // The child's own calls and tokens; the embedded parent history is not counted.
    expect(child.toolCalls.map((call) => call.name)).toEqual(['Bash', 'Spawn_agent']);
    expect(child.inputTokens).toBe(500);
    expect(child.startTime?.toISOString()).toBe(at(40, 33));
    expect(child.endTime?.toISOString()).toBe(at(42, 20));

    expect(grandchild).toMatchObject({
      agentId: GRANDCHILD_ID,
      agentType: 'explorer',
      filePath: tree.grandchild,
      spawnToolUseId: CALL_SPAWN_GRANDCHILD,
      agentNickname: 'Noether',
      agentPath: GRANDCHILD_PATH,
      parentAgentId: CHILD_ID,
      depth: 2,
    });
    expect(grandchild.toolCalls.map((call) => call.name)).toEqual(['Bash']);
    expect(grandchild.inputTokens).toBe(50);
    // The child's own turn started and never completed; the grandchild recorded no turn.
    expect(child.endedCleanly).toBe(false);
    expect(grandchild.endedCleanly).toBeUndefined();
  });

  it('reads a child whose last own turn completed as ended cleanly', () => {
    const tree = writeTree();
    const rows = fs.readFileSync(tree.child, 'utf8');
    fs.appendFileSync(
      tree.child,
      JSON.stringify({
        timestamp: at(42, 21),
        ordinal: rows.trim().split('\n').length,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Done.' },
      }) + '\n',
    );
    useDatabase(tree);
    const [child] = new CodexProvider().scanSubagents(path.dirname(tree.parent), PARENT_ID);
    expect(child.endedCleanly).toBe(true);
  });

  it("links by the spawn output's agent path when the parent has no started records", () => {
    const tree = writeTree({ withoutActivity: true });
    useDatabase(tree);
    const [child] = new CodexProvider().scanSubagents(path.dirname(tree.parent), PARENT_ID);
    expect(child).toMatchObject({ agentId: CHILD_ID, spawnToolUseId: CALL_SPAWN });
  });

  it('falls back to session_meta of recent rollouts without the database', () => {
    const tree = writeTree();
    const subagents = new CodexProvider().scanSubagents(path.dirname(tree.parent), PARENT_ID);
    expect(
      subagents.map((s) => [s.agentId, s.parentAgentId, s.depth, s.spawnToolUseId, s.agentPath]),
    ).toEqual([
      [CHILD_ID, PARENT_ID, 1, CALL_SPAWN, CHILD_PATH],
      [GRANDCHILD_ID, CHILD_ID, 2, CALL_SPAWN_GRANDCHILD, GRANDCHILD_PATH],
    ]);
    expect(subagents[0].description).toBe('Banach');
    expect(subagents[0].inputTokens).toBe(500);
  });

  it('picks up a grown parent rollout incrementally', () => {
    const tree = writeTree();
    useDatabase(tree);
    const provider = new CodexProvider();
    fakeDb.state!.threads = fakeDb.state!.threads.filter((t) => t.id !== GRANDCHILD_ID);
    // First scan: the parent has not recorded the spawn yet.
    const rows = parentRollout({ cwd: CWD });
    const spawnAt = rows.findIndex(
      (row) => (row.payload as Record<string, unknown>).item !== undefined,
    );
    write(tree.parent, rows.slice(0, spawnAt), new Date('2026-10-31T01:40:33Z'));
    expect(provider.scanSubagents('', PARENT_ID)[0].spawnToolUseId).toBeUndefined();
    fs.appendFileSync(tree.parent, toJsonl(rows.slice(spawnAt)));
    expect(provider.scanSubagents('', PARENT_ID)[0].spawnToolUseId).toBe(CALL_SPAWN);
  });

  it.skipIf(!hasZstd)('reads a compressed child only with includeCompressedRollouts', () => {
    const tree = writeTree();
    useDatabase(tree);
    const compressed = compress(tree.grandchild);

    const plain = new CodexProvider().scanSubagents('', PARENT_ID);
    expect(plain.map((s) => s.agentId)).toEqual([CHILD_ID]);

    const withCompressed = new CodexProvider({ includeCompressedRollouts: true }).scanSubagents(
      '',
      PARENT_ID,
    );
    expect(withCompressed.map((s) => [s.agentId, s.filePath])).toEqual([
      [CHILD_ID, tree.child],
      [GRANDCHILD_ID, compressed],
    ]);
    expect(withCompressed[1].inputTokens).toBe(50);
    expect(withCompressed[1].spawnToolUseId).toBe(CALL_SPAWN_GRANDCHILD);
  });
});

describe('CodexProvider.findActiveSession', () => {
  it('skips subagent threads in the database', () => {
    const tree = writeTree();
    useDatabase(tree);
    expect(new CodexProvider().findActiveSession(CWD)).toBe(tree.parent);
  });

  it('skips subagent rollouts in the file scan', () => {
    const tree = writeTree();
    expect(new CodexProvider().findActiveSession(CWD)).toBe(tree.parent);
  });
});
