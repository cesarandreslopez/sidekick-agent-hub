import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectFolderInfo, SearchHit, SessionProviderBase } from '../providers/types';
import { searchSessions } from './sessionSearch';

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-search-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFolder(dir: string, name: string): ProjectFolderInfo {
  return { dir, name, encodedName: name, sessionCount: 1, lastModified: new Date() };
}

function makeHit(sessionPath: string, line: string, projectPath = ''): SearchHit {
  return { sessionPath, line, eventType: 'user', timestamp: '2026-08-18T10:00:00Z', projectPath };
}

interface FakeSearchProvider {
  provider: SessionProviderBase;
  searchedPaths: string[];
  budgets: number[];
}

function makeProvider(
  baseDir: string,
  folders: ProjectFolderInfo[],
  hitsBySession: Record<string, SearchHit[]>,
  overrides: Record<string, unknown> = {},
): FakeSearchProvider {
  const searchedPaths: string[] = [];
  const budgets: number[] = [];
  const provider = {
    id: 'claude-code',
    displayName: 'fake',
    getProjectsBaseDir: () => baseDir,
    getAllProjectFolders: () => folders,
    findSessionsInDirectory: (directory: string) => {
      if (!fs.existsSync(directory)) return [];
      return fs
        .readdirSync(directory)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => path.join(directory, file));
    },
    searchInSession: (sessionPath: string, _query: string, maxResults: number) => {
      searchedPaths.push(sessionPath);
      budgets.push(maxResults);
      return (hitsBySession[sessionPath] ?? []).slice(0, maxResults);
    },
    ...overrides,
  } as unknown as SessionProviderBase;
  return { provider, searchedPaths, budgets };
}

describe('searchSessions', () => {
  it('returns an empty list when the projects base dir does not exist', async () => {
    const { provider } = makeProvider(path.join(makeTempDir(), 'missing'), [], {});

    expect(await searchSessions(provider, 'query')).toEqual([]);
  });

  it('maps hits from session files discovered by the provider', async () => {
    const baseDir = makeTempDir();
    const folderDir = path.join(baseDir, 'project-a');
    fs.mkdirSync(folderDir);
    const sessionPath = path.join(folderDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{}\n');
    const { provider } = makeProvider(baseDir, [makeFolder(folderDir, 'project-a')], {
      [sessionPath]: [makeHit(sessionPath, 'the matching line', '/workspace/a')],
    });

    const results = await searchSessions(provider, 'matching');

    expect(results).toEqual([
      {
        providerId: 'claude-code',
        projectPath: '/workspace/a',
        sessionPath,
        snippet: 'the matching line',
        eventType: 'user',
        timestamp: '2026-08-18T10:00:00Z',
      },
    ]);
  });

  it('falls back to the folder name when a hit has no project path', async () => {
    const baseDir = makeTempDir();
    const folderDir = path.join(baseDir, 'project-b');
    fs.mkdirSync(folderDir);
    const sessionPath = path.join(folderDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{}\n');
    const { provider } = makeProvider(baseDir, [makeFolder(folderDir, 'project-b')], {
      [sessionPath]: [makeHit(sessionPath, 'line')],
    });

    const [result] = await searchSessions(provider, 'line');

    expect(result.projectPath).toBe('project-b');
  });

  it('filters folders by projectSlug against the encoded name', async () => {
    const baseDir = makeTempDir();
    const dirA = path.join(baseDir, 'slug-a');
    const dirB = path.join(baseDir, 'slug-b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const inA = path.join(dirA, 'a.jsonl');
    const inB = path.join(dirB, 'b.jsonl');
    fs.writeFileSync(inA, '{}\n');
    fs.writeFileSync(inB, '{}\n');
    const { provider, searchedPaths } = makeProvider(
      baseDir,
      [makeFolder(dirA, 'slug-a'), makeFolder(dirB, 'slug-b')],
      { [inA]: [makeHit(inA, 'hit a')], [inB]: [makeHit(inB, 'hit b')] },
    );

    const results = await searchSessions(provider, 'hit', { projectSlug: 'slug-b' });

    expect(results.map((result) => result.snippet)).toEqual(['hit b']);
    expect(searchedPaths).toEqual([inB]);
  });

  it('caps results at maxResults and shrinks the per-session budget', async () => {
    const baseDir = makeTempDir();
    const folderDir = path.join(baseDir, 'busy');
    fs.mkdirSync(folderDir);
    const first = path.join(folderDir, 'a-first.jsonl');
    const second = path.join(folderDir, 'b-second.jsonl');
    fs.writeFileSync(first, '{}\n');
    fs.writeFileSync(second, '{}\n');
    const manyHits = (sessionPath: string): SearchHit[] =>
      Array.from({ length: 5 }, (_, index) => makeHit(sessionPath, `line ${index}`));
    const { provider, budgets } = makeProvider(baseDir, [makeFolder(folderDir, 'busy')], {
      [first]: manyHits(first),
      [second]: manyHits(second),
    });

    const results = await searchSessions(provider, 'line', { maxResults: 7 });

    expect(results).toHaveLength(7);
    // The second session only gets the remaining budget after the first.
    expect(budgets).toEqual([7, 2]);
  });

  it('asks the provider for sessions when the folder dir yields none', async () => {
    const baseDir = makeTempDir();
    // A DB-backed provider reports a synthetic folder dir that does not exist
    // on disk; discovery must fall through to findSessionsInDirectory.
    const syntheticDir = path.join(baseDir, 'synthetic');
    const sessionPath = path.join(syntheticDir, 'db-session.jsonl');
    const { provider } = makeProvider(
      baseDir,
      [makeFolder(syntheticDir, 'synthetic')],
      { [sessionPath]: [makeHit(sessionPath, 'db hit')] },
      { findSessionsInDirectory: () => [sessionPath] },
    );

    const results = await searchSessions(provider, 'db');

    expect(results.map((result) => result.snippet)).toEqual(['db hit']);
  });

  it('returns partial results when the provider throws mid-search', async () => {
    const baseDir = makeTempDir();
    const okDir = path.join(baseDir, 'aa-ok');
    const badDir = path.join(baseDir, 'bb-bad');
    fs.mkdirSync(okDir);
    fs.mkdirSync(badDir);
    const okSession = path.join(okDir, 'ok.jsonl');
    const badSession = path.join(badDir, 'bad.jsonl');
    fs.writeFileSync(okSession, '{}\n');
    fs.writeFileSync(badSession, '{}\n');
    const { provider } = makeProvider(
      baseDir,
      [makeFolder(okDir, 'aa-ok'), makeFolder(badDir, 'bb-bad')],
      { [okSession]: [makeHit(okSession, 'good hit')] },
      {
        searchInSession: (sessionPath: string) => {
          if (sessionPath === badSession) throw new Error('corrupt session');
          return [makeHit(okSession, 'good hit')];
        },
      },
    );

    const results = await searchSessions(provider, 'hit');

    expect(results.map((result) => result.snippet)).toEqual(['good hit']);
  });
});

it.each(['claude-code', 'opencode', 'codex'] as const)(
  'searches a canonical project path with %s without using config-store slugs',
  async (id) => {
    const project = path.join(makeTempDir(), 'my.project with spaces');
    fs.mkdirSync(project);
    const session = '/virtual/session';
    const requested: Array<string | undefined> = [];
    const { provider } = makeProvider(
      '/missing/legacy-storage',
      [],
      {},
      {
        id,
        listSessionFilesAsync: async (workspace: string | undefined) => {
          requested.push(workspace);
          return [{ path: session, workspacePath: project, mtime: new Date() }];
        },
        searchInSession: () => [makeHit(session, 'matching content', project)],
      },
    );
    const results = await searchSessions(provider, 'matching', { projectPath: project });
    expect(requested).toEqual([fs.realpathSync(project)]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ providerId: id, projectPath: project });
  },
);

it('searches database-only sessions and deduplicates repeated session paths', async () => {
  const session = '/virtual/db-sessions/project/session.json';
  const { provider, searchedPaths } = makeProvider(
    '/missing/legacy-storage',
    [],
    {
      [session]: [makeHit(session, 'database match')],
    },
    {
      id: 'opencode',
      listSessionFilesAsync: async () => [
        { path: session, mtime: new Date(), workspacePath: '/workspace' },
        { path: session, mtime: new Date(), workspacePath: '/workspace' },
      ],
    },
  );
  expect(await searchSessions(provider, 'match')).toHaveLength(1);
  expect(searchedPaths).toEqual([session]);
});

it('keeps legacy Codex project slugs scoped to the actual workspace', async () => {
  const cwd = '/workspace/my.project';
  const session = '/virtual/shared-dates/session.jsonl';
  const requested: string[] = [];
  const { provider } = makeProvider(
    '/missing',
    [makeFolder('/virtual/shared-dates', cwd)],
    {
      [session]: [makeHit(session, 'match', cwd)],
    },
    {
      id: 'codex',
      findAllSessions: (workspace: string) => {
        requested.push(workspace);
        return [session];
      },
      findSessionsInDirectory: () => {
        throw new Error('must not search a shared date directory');
      },
    },
  );
  expect(await searchSessions(provider, 'match', { projectSlug: cwd })).toHaveLength(1);
  expect(requested).toEqual([cwd]);
});

it('stops searching additional sessions when cancelled', async () => {
  const controller = new AbortController();
  const { provider } = makeProvider(
    '/missing',
    [],
    {},
    {
      listSessionFilesAsync: async () =>
        ['first', 'second'].map((path) => ({ path, mtime: new Date(0) })),
      searchInSession: (session: string) => {
        expect(session).toBe('first');
        controller.abort();
        return [makeHit(session, 'match')];
      },
    },
  );
  expect(await searchSessions(provider, 'match', { signal: controller.signal })).toHaveLength(1);
});
