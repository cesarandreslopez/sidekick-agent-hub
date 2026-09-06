import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ provider: {} as Record<string, unknown> }));
vi.mock('../cli', () => ({ resolveProvider: () => mocks.provider }));
import { searchAction } from './search';

afterEach(() => vi.restoreAllMocks());
it.each(['claude-code', 'codex', 'opencode'])(
  'passes --project as a workspace path for %s',
  async (id) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-search-command-'));
    try {
      const project = path.join(directory, 'my.project with spaces');
      fs.mkdirSync(project);
      const enumerate = vi.fn(async () => [
        { path: '/virtual/session', workspacePath: project, mtime: new Date() },
      ]);
      const dispose = vi.fn();
      mocks.provider = {
        id,
        listSessionFilesAsync: enumerate,
        searchInSession: () => [
          {
            sessionPath: '/virtual/session',
            line: 'needle',
            projectPath: project,
            eventType: 'user',
            timestamp: '',
          },
        ],
        dispose,
      };
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await searchAction({}, {
        parent: { opts: () => ({ json: true, project }) },
        opts: () => ({ query: 'needle' }),
      } as unknown as Command);
      expect(enumerate).toHaveBeenCalledWith(fs.realpathSync(project));
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toHaveLength(1);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
