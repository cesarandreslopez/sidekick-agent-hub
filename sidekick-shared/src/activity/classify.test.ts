import { describe, expect, it } from 'vitest';
import { classifyActivityShell, classifyActivityTool } from './classify';

describe('classifyActivityTool: name table', () => {
  it.each([
    // Claude Code
    ['Read', { file_path: '/work/demo/src/a.ts' }, 'files', 'src/a.ts'],
    ['Write', { file_path: '/work/demo/src/a.ts' }, 'files', 'src/a.ts'],
    ['Edit', { file_path: '/work/demo/src/a.ts' }, 'files', 'src/a.ts'],
    ['MultiEdit', { file_path: '/work/demo/src/a.ts' }, 'files', 'src/a.ts'],
    ['NotebookEdit', { notebook_path: '/work/n/x.ipynb' }, 'files', 'n/x.ipynb'],
    ['Grep', { pattern: 'secret' }, 'files', 'Grep'],
    ['Glob', { pattern: '**/*.ts' }, 'files', 'Glob'],
    ['WebSearch', { query: 'secret' }, 'network', 'web search'],
    ['Agent', { subagent_type: 'Explore', prompt: 'secret' }, 'agents', 'Explore'],
    ['Task', { prompt: 'secret' }, 'agents', 'subagent'],
    ['SendMessage', { message: 'secret' }, 'agents', 'SendMessage'],
    ['Skill', { skill: 'review' }, 'skills', 'review'],
    ['ToolSearch', { query: 'secret' }, 'skills', 'loading tools'],
    ['TodoWrite', { todos: [] }, 'plan', 'todo list'],
    ['TaskCreate', { subject: 'secret' }, 'plan', 'todo list'],
    ['EnterPlanMode', {}, 'plan', 'plan mode'],
    ['ExitPlanMode', { plan: 'secret' }, 'plan', 'plan mode'],
    ['AskUserQuestion', { questions: ['secret'] }, 'you', 'question for you'],
    // Codex (canonical names the parser emits)
    ['UpdatePlan', { plan: [] }, 'plan', 'plan update'],
    ['Spawn_agent', { agent_type: 'worker', message: 'secret' }, 'agents', 'worker'],
    ['View_image', { path: '/tmp/shot.png' }, 'files', 'tmp/shot.png'],
    ['Wait_agent', {}, 'agents', 'Wait agent'],
    // OpenCode (normalized names)
    ['Subtask', { description: 'secret' }, 'agents', 'subagent'],
    ['Lsp', { query: 'secret' }, 'files', 'Lsp'],
    [
      'ApplyPatch',
      { patchText: '*** Update File: src/a.ts\n*** Add File: src/b.ts' },
      'files',
      'src/a.ts +1',
    ],
  ])('%s → %s', (name, input, station, label) => {
    const result = classifyActivityTool(name, input as Record<string, unknown>);
    expect(result.station).toBe(station);
    expect(result.label).toBe(label);
    expect(result.tool).toBe(name);
  });

  it('names a fetch by its host only', () => {
    const result = classifyActivityTool('WebFetch', {
      url: 'https://u:secret@docs.example.com/p?q=secret',
      prompt: 'secret',
    });
    expect(result).toMatchObject({ station: 'network', label: 'docs.example.com', hint: 'remote' });
  });

  it('marks memory paths and instruction files as memory', () => {
    expect(
      classifyActivityTool('Read', { file_path: '/home/u/.claude/projects/-w/memory/MEMORY.md' })
        .station,
    ).toBe('memory');
    expect(classifyActivityTool('Read', { file_path: '/w/CLAUDE.md' }).station).toBe('memory');
    expect(classifyActivityTool('Read', { file_path: '/w/AGENTS.md' }).station).toBe('memory');
    expect(
      classifyActivityTool(
        'Read',
        { file_path: '/w/notes/plan.md' },
        { memory: { paths: ['/notes/'] } },
      ).station,
    ).toBe('memory');
  });

  it('marks the parsers’ synthetic calls as instant', () => {
    expect(
      classifyActivityTool('Edit', { file_path: 'a.ts', _sidekickRawToolName: 'patch_applied' })
        .instant,
    ).toBe(true);
    expect(
      classifyActivityTool('EnterPlanMode', { _sidekickRawToolName: 'task_started' }).instant,
    ).toBe(true);
    expect(classifyActivityTool('Edit', { file_path: 'a.ts' }).instant).toBeUndefined();
  });

  it('falls back to the shell under the tool’s own name', () => {
    expect(classifyActivityTool('SomethingNew', {})).toMatchObject({
      station: 'shell',
      label: 'SomethingNew',
    });
  });
});

describe('classifyActivityTool: MCP routing', () => {
  it('sends unknown servers to the network as `server: tool`', () => {
    expect(classifyActivityTool('mcp__docs__lookup_page', { q: 'secret' })).toMatchObject({
      station: 'network',
      label: 'docs: lookup page',
    });
  });

  it('routes memory servers to memory, with a short id only', () => {
    expect(classifyActivityTool('mcp__memory__open_nodes', { id: 7 }).label).toBe('open nodes #7');
    expect(
      classifyActivityTool('mcp__memory__open_nodes', { id: 'a long secret id here' }).label,
    ).toBe('open nodes');
    expect(
      classifyActivityTool('mcp__recall__search', {}, { memory: { servers: ['recall'] } }).station,
    ).toBe('memory');
  });

  it('routes browser servers by host, with plugin prefixes taken off', () => {
    expect(
      classifyActivityTool('mcp__claude-in-chrome__navigate', {
        url: 'https://app.example.org/x?y',
      }),
    ).toMatchObject({ station: 'browser', label: 'app.example.org' });
    expect(classifyActivityTool('mcp__plugin_web_playwright__click', {}).station).toBe('browser');
  });

  it('applies station overrides for servers and tools', () => {
    expect(
      classifyActivityTool(
        'mcp__notes__save',
        {},
        { stationOverrides: { servers: { notes: 'memory' } } },
      ).station,
    ).toBe('memory');
    expect(
      classifyActivityTool(
        'Bash',
        { command: 'ls' },
        { stationOverrides: { tools: { Bash: 'hooks' } } },
      ).station,
    ).toBe('hooks');
  });

  it('reads the server of a Codex MCP call from its input', () => {
    expect(
      classifyActivityTool('Lookup', {
        _sidekickRawToolName: 'lookup',
        _sidekickMcpServerName: 'docs',
      }),
    ).toMatchObject({ station: 'network', label: 'docs: lookup' });
  });

  it('hides server names in `none` mode', () => {
    expect(classifyActivityTool('mcp__docs__lookup', {}, { labels: 'none' })).toMatchObject({
      label: 'mcp call',
      labelKey: 'mcpCall',
    });
  });
});

describe('classifyActivityTool: label modes', () => {
  it('shows the Bash description only in descriptive mode', () => {
    const input = { command: 'npm test', description: 'Run the unit tests' };
    expect(classifyActivityTool('Bash', input).label).toBe('npm test');
    expect(classifyActivityTool('Bash', input, { labels: 'descriptive' }).label).toBe(
      'Run the unit tests',
    );
    expect(classifyActivityTool('Bash', input, { labels: 'none' })).toMatchObject({
      label: 'command',
      labelKey: 'command',
    });
  });

  it('uses only vocabulary words in none mode', () => {
    expect(classifyActivityTool('Read', { file_path: '/w/a.ts' }, { labels: 'none' }).label).toBe(
      'read',
    );
    expect(
      classifyActivityTool('Agent', { subagent_type: 'Explore' }, { labels: 'none' }).label,
    ).toBe('subagent');
    expect(
      classifyActivityTool('WebFetch', { url: 'https://x.com' }, { labels: 'none' }).label,
    ).toBe('fetch');
  });
});

describe('classifyActivityShell', () => {
  it.each([
    ['npm test', 'shell', 'npm test', 'test'],
    ['npm run build', 'shell', 'npm run build', 'build'],
    ['pnpm vitest run', 'shell', 'pnpm vitest', undefined],
    ['npx vitest run src', 'shell', 'vitest', 'test'],
    ['cargo test --all', 'shell', 'cargo test', 'test'],
    ['go test ./...', 'shell', 'go test', 'test'],
    ['pytest -q', 'shell', 'pytest', 'test'],
    ['tsc --noEmit', 'shell', 'tsc', 'build'],
    ['eslint src', 'shell', 'eslint', 'lint'],
    ['git status --short', 'shell', 'git status', 'vcs'],
    ['git push origin main', 'network', 'git push', 'remote'],
    ['npm install left-pad', 'network', 'npm install', 'install'],
    [
      'curl -s https://api.example.net/v1?token=secret',
      'network',
      'curl api.example.net',
      'remote',
    ],
    ['ssh user@secret-host.example.com ls', 'network', 'ssh', 'remote'],
    ['gh pr view 12', 'network', 'gh pr', 'remote'],
    ['cat src/a.ts | grep secret', 'files', 'cat', 'search'],
    ['sed -i s/a/b/ src/a.ts', 'files', 'sed', 'edit'],
    ['rm -rf build', 'files', 'rm', 'edit'],
    ['ls -la', 'files', 'ls', 'read'],
    ['cd src && ls', 'files', 'ls', 'read'],
    ['FOO=1 sudo npm test', 'shell', 'npm test', 'test'],
    ['timeout 30 npm test', 'shell', 'npm test', 'test'],
    ['uv run pytest', 'shell', 'pytest', 'test'],
    ['echo $(curl -s https://x.example.com)', 'network', 'curl x.example.com', 'remote'],
    ["bash -lc 'npm test'", 'shell', 'npm test', 'test'],
    ['python3 scripts/build.py --fast', 'shell', 'build', undefined],
  ])('%s', (command, station, label, hint) => {
    const result = classifyActivityShell(command);
    expect(result.station).toBe(station);
    expect(result.label).toBe(label);
    expect(result.hint).toBe(hint);
  });

  it('unwraps argv shell wrappers', () => {
    expect(classifyActivityShell(['bash', '-lc', 'npm test']).label).toBe('npm test');
    expect(classifyActivityShell(['git', 'status'])).toMatchObject({
      station: 'shell',
      label: 'git status',
    });
  });

  it('matches memory commands by whole name and shows only listed subcommands', () => {
    const memory = { commands: ['recall'], subcommands: ['add'] };
    expect(classifyActivityShell('recall add something secret', { memory })).toEqual({
      station: 'memory',
      label: 'add',
    });
    expect(classifyActivityShell('recall secret-query', { memory })).toEqual({
      station: 'memory',
      label: 'recall',
    });
    expect(classifyActivityShell('python3 recall-sync.py', { memory }).station).toBe('memory');
    expect(classifyActivityShell('recallable', { memory }).station).toBe('shell');
  });

  it('marks file commands on memory paths as memory', () => {
    expect(classifyActivityShell('cat /home/u/.claude/projects/-w/memory/MEMORY.md').station).toBe(
      'memory',
    );
  });

  it('never returns the command line', () => {
    const secret = 'SKCANARY';
    for (const command of [
      `npm test -- --grep ${secret}`,
      `curl https://example.com/${secret}?${secret}`,
      `cat ${secret}.txt`,
      `./scripts/${secret}`,
      `node -e "console.log('${secret}')"`,
    ]) {
      expect(classifyActivityShell(command).label).not.toContain(secret);
    }
  });
});

describe('classifyActivityTool: Codex code-mode cells', () => {
  it('classifies a cell by its most outward-facing inner tool', () => {
    const cell = classifyActivityTool('Exec', {
      raw: 'await tools.exec_command({cmd: "git status"}); await tools.web__run({q: "x"});',
    });
    expect(cell).toMatchObject({ station: 'network', label: 'web', tool: 'Exec' });
  });

  it('classifies an inner command by its program and drops it', () => {
    const cell = classifyActivityTool('Exec', {
      raw: 'const r = await tools.exec_command({cmd: "npm test -- SKCANARY"});',
    });
    expect(cell).toMatchObject({ station: 'shell', label: 'npm test', hint: 'test' });
  });
});
