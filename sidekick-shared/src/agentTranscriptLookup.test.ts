import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexRolloutDayCandidates,
  findClaudeSessionFile,
  locateCodexRolloutFile,
} from './agentPaths';
import { getCodexSessionsDirs } from './codexPaths';
import { findCodexRolloutFile } from './providers/codexRollouts';
import { isCompressedRolloutPath } from './providers/compressedRollouts';
import { walkRolloutFiles } from './providers/rolloutWalker';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-transcript-lookup-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(file: string, mtimeMs: number, content = '{}\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

/** A UUIDv7 thread id created at `createdMs`, with a distinguishing tail. */
function v7(createdMs: number, tail: number): string {
  const hex = createdMs.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${tail.toString(16).padStart(12, '0')}`;
}

function rolloutName(id: string, ext = '.jsonl'): string {
  return `rollout-2026-08-24T19-45-45-${id}${ext}`;
}

describe('codexRolloutDayCandidates', () => {
  it('gives the UTC date of a UUIDv7 id and the days either side', () => {
    const id = v7(Date.UTC(2026, 7, 25, 2, 45, 45), 1);
    expect(codexRolloutDayCandidates(id)).toEqual([
      path.join('2026', '08', '25'),
      path.join('2026', '08', '24'),
      path.join('2026', '08', '26'),
    ]);
    expect(codexRolloutDayCandidates(id.toUpperCase())).toHaveLength(3);
  });

  it('matches how Codex files a real rollout (local date of the creating machine)', () => {
    // Created 2026-08-25T02:45:45Z, filed under 2026/08/24 by a UTC-7 machine.
    expect(codexRolloutDayCandidates('01a036cf-3960-7000-8000-000000000001')).toContain(
      path.join('2026', '08', '24'),
    );
  });

  it('gives nothing for ids that are not UUIDv7', () => {
    for (const id of [
      '019d86b0-b20c-4b02-a3b2-000000000001',
      'not-a-uuid',
      '',
      undefined as unknown as string,
    ]) {
      expect(codexRolloutDayCandidates(id)).toEqual([]);
    }
  });
});

describe('findClaudeSessionFile', () => {
  const claudeHome = () => path.join(root, 'claude');

  it("checks the workspace's own project folder first", () => {
    const workspace = path.join(root, 'work', 'my_app');
    fs.mkdirSync(workspace, { recursive: true });
    const file = touch(
      path.join(
        claudeHome(),
        'projects',
        '-' + workspace.slice(1).replace(/[^a-zA-Z0-9]/g, '-'),
        's-1.jsonl',
      ),
      1_000,
    );
    expect(
      findClaudeSessionFile('s-1', {
        homes: { claudeHomes: [claudeHome()] },
        workspacePath: workspace,
        maxProjectDirs: 0,
      }),
    ).toBe(file);
  });

  it("finds the workspace folder under its realpath's spelling", () => {
    const real = path.join(root, 'real-app');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(root, 'linked-app');
    fs.symlinkSync(real, link, 'dir');
    const file = touch(
      path.join(claudeHome(), 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), 's-2.jsonl'),
      1_000,
    );
    expect(
      findClaudeSessionFile('s-2', {
        homes: { claudeHomes: [claudeHome()] },
        workspacePath: link,
        maxProjectDirs: 0,
      }),
    ).toBe(file);
  });

  it('scans project folders across homes, the newest copy winning', () => {
    const other = path.join(root, 'claude-2');
    touch(path.join(claudeHome(), 'projects', '-a', 's-3.jsonl'), 1_000_000);
    const newest = touch(path.join(other, 'projects', '-b', 's-3.jsonl'), 2_000_000);
    touch(path.join(claudeHome(), 'projects', '-c', 'other.jsonl'), 3_000_000);
    expect(findClaudeSessionFile('s-3', { homes: { claudeHomes: [claudeHome(), other] } })).toBe(
      newest,
    );
    expect(
      findClaudeSessionFile('s-3', {
        homes: { claudeHomes: [claudeHome(), other] },
        maxProjectDirs: 0,
      }),
    ).toBeNull();
    expect(findClaudeSessionFile('missing', { homes: { claudeHomes: [claudeHome()] } })).toBeNull();
  });

  it('refuses ids that are not one file name, and never throws', () => {
    touch(path.join(claudeHome(), 'projects', '-a', 'x.jsonl'), 1_000);
    for (const id of ['../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(300)]) {
      expect(findClaudeSessionFile(id, { homes: { claudeHomes: [claudeHome()] } }), id).toBeNull();
    }
    expect(findClaudeSessionFile(undefined as unknown as string)).toBeNull();
    expect(() =>
      findClaudeSessionFile('x', { homes: { claudeHomes: ['relative', ''] }, env: { HOME: root } }),
    ).not.toThrow();
  });

  it('follows the environment and the start folders when homes are omitted', () => {
    const workspace = path.join(root, 'proj');
    const file = touch(path.join(workspace, 'projects', '-proj', 's-4.jsonl'), 1_000);
    const env = { HOME: root, CLAUDE_CONFIG_DIR: '' };
    expect(findClaudeSessionFile('s-4', { env })).toBeNull();
    expect(findClaudeSessionFile('s-4', { env, agentCwds: [workspace] })).toBe(file);
  });
});

describe('locateCodexRolloutFile and findCodexRolloutFile', () => {
  const homeA = () => path.join(root, 'codex-a');
  const homeB = () => path.join(root, 'codex-b');
  const homes = () => ({ codexHomes: [homeA(), homeB()] });
  const created = Date.UTC(2026, 7, 25, 2, 45, 45);
  const dayDir = (home: string, day = '2026/08/24') =>
    path.join(home, 'sessions', ...day.split('/'));

  it('finds a rollout in the dated folder its id points to', () => {
    const id = v7(created, 1);
    const file = touch(path.join(dayDir(homeA()), rolloutName(id)), 1_000);
    expect(locateCodexRolloutFile(id, { homes: homes() })).toBe(file);
    expect(locateCodexRolloutFile(id.toUpperCase(), { homes: homes() })).toBe(file);
  });

  it('finds archived rollouts, and skips them with includeArchived false', () => {
    const id = v7(created, 2);
    const file = touch(path.join(homeB(), 'archived_sessions', rolloutName(id)), 1_000);
    expect(locateCodexRolloutFile(id, { homes: homes() })).toBe(file);
    expect(locateCodexRolloutFile(id, { homes: homes(), includeArchived: false })).toBeNull();
  });

  it('prefers a live copy over a compressed one, and the newest copy across homes', () => {
    const id = v7(created, 3);
    const compressed = touch(path.join(dayDir(homeA()), rolloutName(id, '.jsonl.zst')), 9_000_000);
    expect(locateCodexRolloutFile(id, { homes: homes() })).toBeNull();
    expect(locateCodexRolloutFile(id, { homes: homes(), includeCompressed: true })).toBe(
      compressed,
    );
    touch(path.join(dayDir(homeA(), '2026/08/25'), rolloutName(id)), 1_000_000);
    const newest = touch(path.join(dayDir(homeB()), rolloutName(id)), 2_000_000);
    expect(locateCodexRolloutFile(id, { homes: homes(), includeCompressed: true })).toBe(newest);
  });

  it('walks the trees when the dated folders miss, or for ids that are not UUIDv7', () => {
    const moved = v7(created, 4);
    const movedFile = touch(path.join(dayDir(homeA(), '2026/01/02'), rolloutName(moved)), 1_000);
    expect(locateCodexRolloutFile(moved, { homes: homes() })).toBe(movedFile);
    expect(locateCodexRolloutFile(moved, { homes: homes(), maxDirs: 0 })).toBeNull();
    const legacy = '019d86b0-b20c-4b02-a3b2-000000000001';
    const legacyFile = touch(path.join(dayDir(homeB(), '2025/03/04'), rolloutName(legacy)), 1_000);
    expect(locateCodexRolloutFile(legacy, { homes: homes() })).toBe(legacyFile);
    expect(locateCodexRolloutFile('../x', { homes: homes() })).toBeNull();
    expect(locateCodexRolloutFile('', { homes: homes() })).toBeNull();
  });

  it('gives the same answer as the full walk (differential)', () => {
    const ids: string[] = [];
    let mtime = 1_000_000;
    const place = (home: string, day: string, id: string, ext = '.jsonl') =>
      touch(path.join(dayDir(home, day), rolloutName(id, ext)), (mtime += 1_000));
    for (let index = 0; index < 12; index++) {
      const id = v7(created + index * 3_600_000, 100 + index);
      ids.push(id);
      const day = index % 2 === 0 ? '2026/08/24' : '2026/08/25';
      place(index % 3 === 0 ? homeB() : homeA(), day, id);
      if (index % 4 === 0) place(index % 3 === 0 ? homeA() : homeB(), '2026/08/25', id);
      if (index % 5 === 0) place(homeA(), '2026/08/26', id, '.jsonl.zst');
    }
    const archivedId = v7(created, 200);
    ids.push(archivedId);
    touch(path.join(homeA(), 'archived_sessions', rolloutName(archivedId)), (mtime += 1_000));
    const compressedOnly = v7(created, 201);
    ids.push(compressedOnly);
    place(homeB(), '2026/08/24', compressedOnly, '.jsonl.zst');
    const legacy = '019d86b0-b20c-4b02-a3b2-000000000002';
    ids.push(legacy);
    place(homeB(), '2025/03/04', legacy);
    ids.push(v7(created, 999)); // absent everywhere

    const reference = (id: string, includeCompressed: boolean): string | null => {
      const matches = walkRolloutFiles(getCodexSessionsDirs([homeA(), homeB()]), {
        sessionId: id,
        includeCompressed,
      });
      return (
        (matches.find((file) => !isCompressedRolloutPath(file.path)) ?? matches[0])?.path ?? null
      );
    };
    for (const includeCompressed of [false, true]) {
      for (const id of ids) {
        const expected = reference(id, includeCompressed);
        expect(
          findCodexRolloutFile(id, { codexHomes: [homeA(), homeB()], includeCompressed }),
          `${id} find ${includeCompressed}`,
        ).toBe(expected);
        expect(
          locateCodexRolloutFile(id, { homes: homes(), includeCompressed }),
          `${id} locate ${includeCompressed}`,
        ).toBe(expected);
      }
    }
  });
});
