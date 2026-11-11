/**
 * Which station a tool call belongs to and what to call it, for Claude Code,
 * Codex and OpenCode tool names (as the shared parsers emit them).
 *
 * Rules, in order:
 *
 * 1. `stationOverrides.tools[name]`.
 * 2. MCP calls (`mcp__server__tool`, or a Codex call that names its server):
 *    `stationOverrides.servers`, then memory servers, then browser servers,
 *    then `terminal` → shell; any other server is the network.
 * 3. The name table below.
 * 4. Shell tools go through {@link classifyActivityShell}.
 * 5. Anything else falls back to the shared tool categories, and finally to
 *    the shell station under the tool's own name.
 *
 * Labels follow the privacy rules in `activity/labels`: names, never content.
 * A shell command is named by its program (and a known subcommand), never
 * its command line; the model-written description shows only in
 * `descriptive` mode.
 *
 * Pure.
 *
 * @module activity/classify
 */

import { extractPatchFilePaths } from '../parsers/patchPaths';
import { parseMcpToolName } from '../parsers/mcpToolName';
import { commandOf, commandWord, shellSegments, unwrapShellScript } from '../shellCommand';
import { classifyTool } from '../toolCategory';
import {
  activityHostLabel,
  activityPathLabel,
  cleanActivityLabel,
  identifierLabel,
  readableName,
} from './labels';
import type { ActivityStationId } from './stations';
import { DEFAULT_ACTIVITY_STRINGS, type ActivityLabelKey } from './strings';
import type {
  ActivityClassification,
  ActivityClassifyOptions,
  ActivityHint,
  ActivityLabelMode,
} from './types';

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_SERVERS: readonly string[] = ['memory'];
const DEFAULT_INSTRUCTION_FILES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
];
const DEFAULT_BROWSER_SERVERS: readonly string[] = [
  'claude-in-chrome',
  'Claude_Browser',
  'Claude_Preview',
  'playwright',
  'puppeteer',
  'chrome-devtools',
  'browserbase',
  'computer-use',
];

/** Claude Code's own memory folder counts for everyone. */
const CLAUDE_MEMORY_PATH = /\/\.claude\/projects\/[^/]+\/memory\//;

/** Longest command text examined, so a giant heredoc costs nothing. */
const MAX_COMMAND_CHARS = 8192;

// ── Name table ───────────────────────────────────────────────────────────

type Kind =
  | 'file-read'
  | 'file-edit'
  | 'file-search'
  | 'shell'
  | 'stdin'
  | 'web-fetch'
  | 'web-search'
  | 'network-tool'
  | 'agent-spawn'
  | 'agent-tool'
  | 'skill'
  | 'tool-search'
  | 'slash-command'
  | 'todo'
  | 'plan-mode'
  | 'plan-update'
  | 'plan-tool'
  | 'question'
  | 'file-for-you'
  | 'notify'
  | 'code-cell';

const KIND_BY_NAME = new Map<string, Kind>(
  (
    [
      ['file-read', ['read', 'notebookread', 'ls', 'list', 'view_image']],
      [
        'file-edit',
        [
          'write',
          'edit',
          'multiedit',
          'notebookedit',
          'applypatch',
          'apply_patch',
          'patch',
          'patch_applied',
        ],
      ],
      ['file-search', ['grep', 'glob', 'lsp']],
      [
        'shell',
        [
          'bash',
          'bashoutput',
          'killshell',
          'killbash',
          'monitor',
          'enterworktree',
          'exitworktree',
          'shell',
          'local_shell',
          'local_shell_call',
          'exec_command',
          'container.exec',
          'wait',
        ],
      ],
      ['stdin', ['write_stdin']],
      ['web-fetch', ['webfetch', 'fetch']],
      ['web-search', ['websearch', 'web_search', 'web_search_call', 'codesearch']],
      ['network-tool', ['artifact', 'listmcpresourcestool', 'readmcpresourcetool']],
      ['agent-spawn', ['agent', 'task', 'subtask', 'spawn_agent']],
      [
        'agent-tool',
        [
          'sendmessage',
          'send_message',
          'taskstop',
          'taskoutput',
          'listagents',
          'list_agents',
          'subagenthandback',
          'workflow',
          'wait_agent',
          'followup_task',
          'interrupt_agent',
          'close_agent',
        ],
      ],
      ['skill', ['skill']],
      ['tool-search', ['toolsearch']],
      ['slash-command', ['slashcommand']],
      ['todo', ['todowrite', 'todoread', 'taskcreate', 'taskupdate', 'tasklist', 'taskget']],
      ['plan-mode', ['enterplanmode', 'exitplanmode']],
      ['plan-update', ['updateplan', 'update_plan']],
      ['plan-tool', ['schedulewakeup', 'croncreate', 'cronlist', 'crondelete']],
      ['question', ['askuserquestion', 'request_user_input', 'question']],
      ['file-for-you', ['senduserfile']],
      ['notify', ['pushnotification', 'sendfeedback', 'readnotifications']],
      ['code-cell', ['exec']],
    ] as Array<[Kind, string[]]>
  ).flatMap(([kind, names]) => names.map((name) => [name, kind] as const)),
);

/** Raw names of the parsers' synthetic calls, which the log records as already done. */
const INSTANT_RAW_TOOLS: ReadonlySet<string> = new Set([
  'patch_applied',
  'task_started',
  'task_complete',
]);

// ── Shell rules ──────────────────────────────────────────────────────────

/** Commands that work on files and nothing else: they read, search, move or edit them. */
const FILE_WORDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'fd',
  'find',
  'ls',
  'wc',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'chmod',
  'diff',
  'cmp',
  'comm',
  'sort',
  'uniq',
  'cut',
  'paste',
  'column',
  'tr',
  'awk',
  'tee',
  'stat',
  'file',
  'du',
  'tree',
  'ln',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'jq',
  'yq',
  'bat',
  'less',
  'more',
  'nl',
  'xxd',
  'md5sum',
  'sha256sum',
  'shasum',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'patch',
]);
const FILE_EDIT_WORDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'patch',
  'tee',
  'ln',
]);
const FILE_SEARCH_WORDS: ReadonlySet<string> = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'find',
  'fd',
  'ag',
]);
/** Say nothing either way about what a command line does. */
const NEUTRAL_WORDS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'cd',
  'pushd',
  'popd',
  'export',
  'true',
  'false',
  'set',
  'unset',
  'pwd',
  'sleep',
  'which',
  'type',
  'test',
  '[',
  '[[',
  ':',
  'source',
  '.',
]);
const NET_WORDS: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'aria2c',
  'gh',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'ping',
  'dig',
  'nslookup',
  'host',
  'whois',
  'traceroute',
  'aws',
  'gcloud',
  'az',
  'kubectl',
  'helm',
  'terraform',
  'vercel',
  'netlify',
  'flyctl',
  'heroku',
  'wrangler',
]);
/** Commands that reach the network only with some subcommands. */
const NET_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote']),
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'publish', 'view', 'audit', 'outdated']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'outdated']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish']),
  bun: new Set(['install', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  uv: new Set(['add', 'sync', 'pip']),
  poetry: new Set(['add', 'install', 'update']),
  go: new Set(['get']),
  gem: new Set(['install']),
  composer: new Set(['install', 'require', 'update']),
  docker: new Set(['pull', 'push', 'login']),
  brew: new Set(['install', 'update', 'upgrade', 'fetch']),
  cargo: new Set(['install', 'fetch', 'publish', 'update']),
};
/** Programs that run a script named by their next word. */
const RUNNERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'bash',
  'sh',
  'zsh',
  'deno',
  'bun',
  'ruby',
  'perl',
  'tsx',
  'ts-node',
]);
/** Programs dropped in front of the real one (`sudo npm i` is npm). */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'time',
  'nohup',
  'nice',
  'exec',
  'command',
  'stdbuf',
  'xargs',
  'npx',
  'bunx',
  'uvx',
]);
/** Two-word wrappers (`uv run x`, `pnpm dlx x`, `poetry run x`, `bundle exec x`). */
const TWO_WORD_WRAPPERS: Readonly<Record<string, string>> = {
  uv: 'run',
  pnpm: 'dlx',
  poetry: 'run',
  bundle: 'exec',
};
/** Programs whose next word is worth naming (`git status`, `npm test`). */
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'git',
  'gh',
  'cargo',
  'go',
  'make',
  'docker',
  'kubectl',
  'uv',
  'deno',
  'dotnet',
  'mvn',
  'gradle',
  'poetry',
  'pip',
  'pip3',
  'brew',
]);
const SUBCOMMAND = /^[a-z][a-z0-9:_-]{0,24}$/;
const TEST_PROGRAMS: ReadonlySet<string> = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'pytest',
  'tox',
  'nox',
  'rspec',
  'phpunit',
  'ctest',
]);
const BUILD_PROGRAMS: ReadonlySet<string> = new Set([
  'tsc',
  'esbuild',
  'webpack',
  'rollup',
  'vite',
  'turbo',
  'nx',
  'bazel',
  'cmake',
]);
const LINT_PROGRAMS: ReadonlySet<string> = new Set([
  'eslint',
  'prettier',
  'ruff',
  'flake8',
  'pylint',
  'biome',
  'stylelint',
  'shellcheck',
  'golangci-lint',
]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The words of a command with wrapper programs taken off the front. */
function unwrapWords(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const name = commandWord(words[index]);
    if (WRAPPERS.has(name)) {
      index++;
      // `timeout 30 cmd`, `nice -n 5 cmd`, `env -i A=1 cmd`: skip flags, numbers, assignments.
      while (
        index < words.length &&
        /^(?:-|\d|[A-Za-z_]\w*=)/.test(words[index] ?? '') &&
        index < words.length - 1
      ) {
        index++;
      }
      continue;
    }
    if (name === 'timeout' && index + 2 < words.length) {
      index += 2;
      continue;
    }
    const second = TWO_WORD_WRAPPERS[name];
    if (second && words[index + 1] === second && index + 2 < words.length) {
      index += 2;
      continue;
    }
    break;
  }
  return words.slice(index);
}

interface Segment {
  program: string;
  words: string[];
  /** For a runner (`python x.py`): the script's name without its extension. */
  script: string;
}

function segmentsOf(text: string, deep: boolean): Segment[] {
  return shellSegments(text, deep)
    .map(unwrapWords)
    .filter((words) => words.length > 0)
    .map((words) => {
      const program = commandWord(words[0]);
      const scriptWord = RUNNERS.has(program)
        ? words.slice(1).find((word) => !word.startsWith('-'))
        : undefined;
      const script = scriptWord ? stem(commandWord(scriptWord)) : '';
      return { program, words, script };
    });
}

/** A script's name without its ending: `recall-sync.py` is `recall-sync`. */
function stem(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** A name is the command itself or begins with it and a separator: `recall` names `recall-sync`, never `recallable`. */
function named(name: string, command: string): boolean {
  if (!name || !command) return false;
  const base = stem(name);
  return (
    base === command || (base.startsWith(command) && /^[-_.]/.test(base.slice(command.length)))
  );
}

function subcommandOf(segment: Segment): string | undefined {
  const sub = segment.words[1]?.replace(/["']/g, '');
  return sub && SUBCOMMAND.test(sub) ? sub : undefined;
}

function hintFor(segment: Segment): ActivityHint | undefined {
  const { program } = segment;
  const sub = subcommandOf(segment);
  const script = sub === 'run' ? segment.words[2]?.replace(/["']/g, '') : undefined;
  const target = script ?? sub ?? '';
  if (TEST_PROGRAMS.has(program)) return 'test';
  if (program === 'playwright' && sub === 'test') return 'test';
  if (PACKAGE_MANAGERS.has(program) || program === 'make' || program === 'just') {
    if (/^test/.test(target)) return 'test';
    if (/^(?:build|compile|bundle|package)/.test(target)) return 'build';
    if (/^(?:lint|format|check)/.test(target)) return 'lint';
    if (PACKAGE_MANAGERS.has(program) && NET_SUBCOMMANDS[program]?.has(sub ?? '')) {
      return 'install';
    }
    if (program === 'make' && (!sub || sub === 'all')) return 'build';
  }
  if (['go', 'cargo', 'deno', 'dotnet', 'mvn', 'gradle'].includes(program)) {
    if (sub === 'test') return 'test';
    if (sub === 'build' || sub === 'compile' || sub === 'package') return 'build';
    if (sub === 'clippy' || sub === 'vet' || sub === 'fmt' || sub === 'lint') return 'lint';
  }
  if (BUILD_PROGRAMS.has(program)) return 'build';
  if (LINT_PROGRAMS.has(program)) return 'lint';
  if (program === 'git') return NET_SUBCOMMANDS.git.has(sub ?? '') ? 'remote' : 'vcs';
  if (['pip', 'pip3', 'uv', 'poetry', 'gem', 'brew', 'composer'].includes(program)) {
    if (NET_SUBCOMMANDS[program]?.has(sub ?? '')) return 'install';
  }
  return undefined;
}

/** `npm test`, `git status`, `npm run build`, `make`, else the program. */
function programLabel(segment: Segment): string {
  const { program } = segment;
  if (!SUBCOMMAND_PROGRAMS.has(program)) return segment.script || program;
  const sub = subcommandOf(segment);
  if (!sub) return program;
  if (sub === 'run' && PACKAGE_MANAGERS.has(program)) {
    const script = segment.words[2]?.replace(/["']/g, '');
    if (script && SUBCOMMAND.test(script)) return `${program} run ${script}`;
  }
  return `${program} ${sub}`;
}

/** A host named by a network command's arguments (a URL), or the program alone. */
function networkLabel(segment: Segment): string {
  const { program } = segment;
  if (['curl', 'wget', 'http', 'https', 'xh', 'aria2c'].includes(program)) {
    const url = segment.words.slice(1).find((word) => /^["']?[a-z][a-z0-9+.-]*:\/\//i.test(word));
    const host = url ? activityHostLabel(url.replace(/^["']|["']$/g, '')) : '';
    return host ? `${program} ${host}` : program;
  }
  if (NET_SUBCOMMANDS[program]) return programLabel(segment);
  if (['gh', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'terraform'].includes(program)) {
    const sub = subcommandOf(segment);
    return sub ? `${program} ${sub}` : program;
  }
  return program;
}

interface ShellOptions {
  memoryCommands: readonly string[];
  memorySubcommands: ReadonlySet<string>;
  memoryPathParts: readonly string[];
  instructionFiles: ReadonlySet<string>;
  labels: ActivityLabelMode;
}

function shellOptions(options: ActivityClassifyOptions | undefined): ShellOptions {
  return {
    memoryCommands: options?.memory?.commands ?? [],
    memorySubcommands: new Set(options?.memory?.subcommands ?? []),
    memoryPathParts: options?.memory?.paths ?? [],
    instructionFiles: new Set(options?.memory?.instructionFiles ?? DEFAULT_INSTRUCTION_FILES),
    labels: options?.labels ?? 'names',
  };
}

function vocabulary(key: ActivityLabelKey): { label: string; labelKey: ActivityLabelKey } {
  return { label: DEFAULT_ACTIVITY_STRINGS.labels[key], labelKey: key };
}

type ShellResult = Pick<ActivityClassification, 'station' | 'label' | 'labelKey' | 'hint'>;

function classifyShellText(text: string, options: ShellOptions): ShellResult {
  const command = unwrapShellScript(text).slice(0, MAX_COMMAND_CHARS);
  const lines = segmentsOf(command, false);
  const none = options.labels === 'none';
  const fallbackLabel = (segment: Segment | undefined): ShellResult =>
    segment && !none
      ? { station: 'shell', label: cleanActivityLabel(programLabel(segment), 48) || 'shell' }
      : { station: 'shell', ...vocabulary('command') };

  // Memory commands first: the person named them.
  for (const segment of lines) {
    const memoryCommand = options.memoryCommands.find(
      (name) => named(segment.program, name) || named(segment.script, name),
    );
    if (!memoryCommand) continue;
    if (none) return { station: 'memory', ...vocabulary('memory') };
    const sub = segment.words[RUNNERS.has(segment.program) ? 2 : 1]?.replace(/["']/g, '');
    const label = sub && options.memorySubcommands.has(sub) ? sub : memoryCommand;
    return { station: 'memory', label: cleanActivityLabel(label, 40) };
  }

  // Anything that reaches the network, also from inside `$(…)`.
  for (const segment of segmentsOf(command, true)) {
    const sub = subcommandOf(segment);
    if (NET_WORDS.has(segment.program) || NET_SUBCOMMANDS[segment.program]?.has(sub ?? '')) {
      const hint = hintFor(segment) ?? 'remote';
      if (none) return { station: 'network', ...vocabulary('fetch'), hint };
      return { station: 'network', label: cleanActivityLabel(networkLabel(segment), 48), hint };
    }
  }

  // Commands that only work on files.
  const real = lines.filter((segment) => !NEUTRAL_WORDS.has(segment.program));
  if (real.length > 0 && real.every((segment) => FILE_WORDS.has(segment.program))) {
    const isMemory = isMemoryText(command, options);
    const edits = real.some(
      (segment) =>
        FILE_EDIT_WORDS.has(segment.program) ||
        (segment.program === 'sed' && segment.words.some((word) => /^-[a-zA-Z]*i/.test(word))) ||
        (segment.program === 'find' && segment.words.includes('-delete')),
    );
    const searches = real.some((segment) => FILE_SEARCH_WORDS.has(segment.program));
    const hint: 'read' | 'edit' | 'search' = edits ? 'edit' : searches ? 'search' : 'read';
    const station: ActivityStationId = isMemory ? 'memory' : 'files';
    if (none) return { station, ...vocabulary(hint), hint };
    return { station, label: cleanActivityLabel(programLabel(real[0]), 48), hint };
  }

  const head = real[0] ?? lines[0];
  const result = fallbackLabel(head);
  const hint = head ? hintFor(head) : undefined;
  return hint ? { ...result, hint } : result;
}

/**
 * The station of a shell command and what to call it. The command line is
 * read for its structure only (which programs run); the label is a program
 * name, a known subcommand or a host, never the command line.
 */
export function classifyActivityShell(
  command: string | readonly string[],
  options?: ActivityClassifyOptions,
): Pick<ActivityClassification, 'station' | 'label' | 'labelKey' | 'hint'> {
  const text = commandOf(command);
  const resolved = shellOptions(options);
  if (!text) {
    return {
      station: 'shell',
      ...(resolved.labels === 'none' ? vocabulary('command') : { label: 'shell' }),
    };
  }
  return classifyShellText(text, resolved);
}

// ── Memory and MCP routing ───────────────────────────────────────────────

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isMemoryPath(path: string, options: ShellOptions): boolean {
  if (!path) return false;
  const normalized = normalizePath(path);
  if (CLAUDE_MEMORY_PATH.test(normalized)) return true;
  const base = normalized.split('/').pop() ?? '';
  if (options.instructionFiles.has(base)) return true;
  return options.memoryPathParts.some((part) => part && normalized.includes(part));
}

function isMemoryText(text: string, options: ShellOptions): boolean {
  const normalized = normalizePath(text);
  if (CLAUDE_MEMORY_PATH.test(normalized)) return true;
  return options.memoryPathParts.some((part) => part && normalized.includes(part));
}

/** Server names as written and with Claude Code's plugin / connector prefixes taken off. */
function serverNames(server: string): string[] {
  const names = [server];
  const plugin = /^plugin_[^_]+_(.+)$/.exec(server)?.[1];
  if (plugin) names.push(plugin);
  const connector = /^claude_ai_(.+)$/.exec(server)?.[1];
  if (connector) names.push(connector);
  return names;
}

function matchesServer(server: string, list: readonly string[]): boolean {
  const names = serverNames(server).map((name) => name.toLowerCase());
  return list.some((entry) => names.includes(entry.toLowerCase()));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function classifyMcp(
  server: string,
  tool: string,
  fullName: string,
  input: Readonly<Record<string, unknown>> | undefined,
  options: ActivityClassifyOptions | undefined,
): ActivityClassification {
  const labels = options?.labels ?? 'names';
  const readable = readableName(tool);
  const overrides = options?.stationOverrides?.servers;
  let station: ActivityStationId = 'network';
  if (overrides) {
    for (const name of serverNames(server)) {
      if (overrides[name]) {
        station = overrides[name];
        break;
      }
    }
  }
  if (station === 'network') {
    if (matchesServer(server, options?.memory?.servers ?? DEFAULT_MEMORY_SERVERS)) {
      station = 'memory';
    } else if (matchesServer(server, options?.browserServers ?? DEFAULT_BROWSER_SERVERS)) {
      station = 'browser';
    } else if (serverNames(server).includes('terminal')) {
      station = 'shell';
    }
  }
  if (labels === 'none') {
    return { station, ...vocabulary('mcpCall'), tool: fullName };
  }
  if (station === 'memory') {
    // A record number or a short identifier: a longer string under `id` could be anything.
    const id = input?.id;
    const suffix =
      typeof id === 'number' && Number.isFinite(id)
        ? ` #${id}`
        : typeof id === 'string' && /^[\w-]{1,24}$/.test(id)
          ? ` #${id}`
          : '';
    return { station, label: `${readable}${suffix}`, tool: fullName };
  }
  if (station === 'browser') {
    const url = str(input?.url);
    const host = url && /^[a-z][a-z0-9+.-]*:/i.test(url) ? activityHostLabel(url) : '';
    return { station, label: host || readable, tool: fullName };
  }
  const serverLabel = readableName(serverNames(server).pop() ?? server, 24);
  return { station, label: cleanActivityLabel(`${serverLabel}: ${readable}`, 60), tool: fullName };
}

// ── Codex code-mode cells ────────────────────────────────────────────────

const STATION_RANK: Readonly<Partial<Record<ActivityStationId, number>>> = {
  network: 5,
  browser: 4,
  memory: 3,
  agents: 2,
  files: 1,
  shell: 0,
};
const INNER_TOOL = /\btools\.([A-Za-z_][\w]{0,63})\s*\(/g;
const INNER_COMMAND = /\b(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1)[^\\\n]){1,2000})\1/;

/**
 * A Codex code-mode cell (`exec`) runs JavaScript that calls tools as
 * `tools.<name>(…)`. Best effort: the most outward-facing inner tool decides
 * the station; an inner `exec_command`'s command is classified by its
 * program and then dropped.
 */
function classifyCodeCell(
  source: string,
  fullName: string,
  options: ActivityClassifyOptions | undefined,
): ActivityClassification {
  const text = source.slice(0, 65_536);
  let best: ActivityClassification | null = null;
  for (const match of text.matchAll(INNER_TOOL)) {
    const inner = match[1];
    let candidate: ActivityClassification;
    if (inner === 'exec_command' || inner === 'shell') {
      const command = INNER_COMMAND.exec(text.slice(match.index ?? 0))?.[2] ?? '';
      candidate = { ...classifyActivityShell(command, options), tool: fullName };
    } else if (/^web/.test(inner)) {
      candidate = {
        station: 'network',
        ...(options?.labels === 'none' ? vocabulary('fetch') : { label: 'web' }),
        tool: fullName,
      };
    } else {
      const mcp = parseMcpToolName(inner);
      candidate = mcp
        ? classifyMcp(mcp.serverName, mcp.toolName, fullName, undefined, options)
        : { ...classifyActivityTool(inner, undefined, options), tool: fullName };
    }
    if (!best || (STATION_RANK[candidate.station] ?? 0) > (STATION_RANK[best.station] ?? 0)) {
      best = candidate;
    }
  }
  return best ?? { station: 'shell', ...vocabulary('command'), tool: fullName };
}

// ── Tool classification ──────────────────────────────────────────────────

function pathOf(input: Readonly<Record<string, unknown>> | undefined): string {
  if (!input) return '';
  return (
    str(input.file_path) ||
    str(input.notebook_path) ||
    str(input.filePath) ||
    str(input.path) ||
    str(input.filename)
  );
}

function descriptionOf(
  input: Readonly<Record<string, unknown>> | undefined,
  labels: ActivityLabelMode,
): string {
  if (labels !== 'descriptive' || !input) return '';
  return cleanActivityLabel(str(input.description), 60);
}

/**
 * The station of a tool call and what to call it. `input` is read for names
 * only (a path, a host, a subagent type, a skill); it is never copied.
 */
export function classifyActivityTool(
  name: string,
  input: Readonly<Record<string, unknown>> | undefined,
  options?: ActivityClassifyOptions,
): ActivityClassification {
  const tool = cleanActivityLabel(typeof name === 'string' ? name : '', 64) || 'tool';
  const labels: ActivityLabelMode = options?.labels ?? 'names';
  const none = labels === 'none';
  const rawName = str(input?._sidekickRawToolName);
  const instant = INSTANT_RAW_TOOLS.has(rawName) ? ({ instant: true } as const) : {};

  const override = options?.stationOverrides?.tools?.[tool];

  // MCP: the full name, or a Codex call that names its server.
  const mcp = parseMcpToolName(tool);
  const codexServer = str(input?._sidekickMcpServerName);
  if (mcp || codexServer) {
    const server = mcp?.serverName ?? codexServer;
    const mcpTool = mcp?.toolName ?? (rawName || tool);
    const result = classifyMcp(server, mcpTool, tool, input, options);
    return override ? { ...result, station: override } : result;
  }

  const shell = shellOptions(options);
  const kind = KIND_BY_NAME.get(tool.toLowerCase()) ?? KIND_BY_NAME.get(rawName.toLowerCase());
  let result: ActivityClassification;
  switch (kind) {
    case 'file-read':
    case 'file-edit':
    case 'file-search': {
      const hint: 'read' | 'edit' | 'search' =
        kind === 'file-read' ? 'read' : kind === 'file-edit' ? 'edit' : 'search';
      let path = pathOf(input);
      let extra = 0;
      if (!path && kind === 'file-edit') {
        const patch = str(input?.input) || str(input?.patch) || str(input?.patchText);
        const paths = patch ? extractPatchFilePaths(patch.slice(0, 262_144)) : [];
        path = paths[0] ?? '';
        extra = Math.max(0, paths.length - 1);
      }
      const station: ActivityStationId = isMemoryPath(path, shell) ? 'memory' : 'files';
      if (none) {
        result = { station, ...vocabulary(hint), hint, tool };
      } else {
        const named = kind === 'file-search' ? '' : activityPathLabel(path);
        const label = named ? (extra > 0 ? `${named} +${extra}` : named) : readableName(tool);
        result = { station, label, hint, tool };
      }
      break;
    }
    case 'shell': {
      const command = input?.command ?? input?.cmd;
      const shellResult =
        command !== undefined
          ? classifyActivityShell(command as string | readonly string[], options)
          : { station: 'shell' as const, label: readableName(tool) };
      // In descriptive mode the model's short description replaces the program
      // name, except for memory commands, whose label the person chose.
      const description = descriptionOf(input, labels);
      result =
        description && shellResult.station !== 'memory'
          ? {
              station: shellResult.station,
              label: description,
              ...(shellResult.hint ? { hint: shellResult.hint } : {}),
              tool,
            }
          : { ...shellResult, tool };
      break;
    }
    case 'stdin':
      result = { station: 'shell', ...vocabulary('stdin'), tool };
      break;
    case 'web-fetch': {
      const host = activityHostLabel(str(input?.url));
      result =
        host && !none
          ? { station: 'network', label: host, hint: 'remote', tool }
          : { station: 'network', ...vocabulary('fetch'), hint: 'remote', tool };
      break;
    }
    case 'web-search':
      result = { station: 'network', ...vocabulary('webSearch'), hint: 'remote', tool };
      break;
    case 'network-tool':
      result = none
        ? { station: 'network', ...vocabulary('tool'), tool }
        : { station: 'network', label: readableName(tool), tool };
      break;
    case 'agent-spawn': {
      const type =
        identifierLabel(input?.subagent_type) ??
        identifierLabel(input?.agent_type) ??
        identifierLabel(input?.agent);
      const description = descriptionOf(input, labels);
      result =
        none || (!type && !description)
          ? { station: 'agents', ...vocabulary('subagent'), tool }
          : { station: 'agents', label: description || (type as string), tool };
      break;
    }
    case 'agent-tool':
      result = none
        ? { station: 'agents', ...vocabulary('subagent'), tool }
        : { station: 'agents', label: readableName(tool), tool };
      break;
    case 'skill': {
      const skill = identifierLabel(input?.skill) ?? identifierLabel(input?.name);
      result =
        skill && !none
          ? { station: 'skills', label: skill, tool }
          : { station: 'skills', ...vocabulary('skill'), tool };
      break;
    }
    case 'tool-search':
      result = { station: 'skills', ...vocabulary('loadingTools'), tool };
      break;
    case 'slash-command': {
      const first = str(input?.command).trim().split(/\s+/)[0] ?? '';
      const command = identifierLabel(first);
      result =
        command && !none
          ? { station: 'skills', label: command, tool }
          : { station: 'skills', ...vocabulary('skill'), tool };
      break;
    }
    case 'todo':
      result = { station: 'plan', ...vocabulary('todoList'), tool };
      break;
    case 'plan-mode':
      result = { station: 'plan', ...vocabulary('planMode'), tool };
      break;
    case 'plan-update':
      result = { station: 'plan', ...vocabulary('planUpdate'), tool };
      break;
    case 'plan-tool':
      result = none
        ? { station: 'plan', ...vocabulary('tool'), tool }
        : { station: 'plan', label: readableName(tool), tool };
      break;
    case 'question':
      result = { station: 'you', ...vocabulary('questionForYou'), tool };
      break;
    case 'file-for-you':
      result = { station: 'you', ...vocabulary('fileForYou'), tool };
      break;
    case 'notify':
      result = none
        ? { station: 'you', ...vocabulary('notification'), tool }
        : { station: 'you', label: readableName(tool), tool };
      break;
    case 'code-cell': {
      const source = str(input?.raw) || str(input?.code) || str(input?.source);
      result = source
        ? classifyCodeCell(source, tool, options)
        : { station: 'shell', ...vocabulary('command'), tool };
      break;
    }
    default: {
      switch (classifyTool(tool)) {
        case 'shell':
          result = { station: 'shell', label: none ? '' : readableName(tool), tool };
          break;
        case 'file_read':
        case 'file_edit':
        case 'search':
          result = { station: 'files', label: none ? '' : readableName(tool), tool };
          break;
        case 'web':
          result = { station: 'network', label: none ? '' : readableName(tool), tool };
          break;
        case 'subagent':
          result = { station: 'agents', label: none ? '' : readableName(tool), tool };
          break;
        case 'planning':
          result = { station: 'plan', label: none ? '' : readableName(tool), tool };
          break;
        default:
          result = { station: 'shell', label: none ? '' : readableName(tool), tool };
          break;
      }
      if (!result.label) result = { ...result, ...vocabulary('tool') };
      break;
    }
  }
  const classified = { ...result, ...instant };
  return override ? { ...classified, station: override } : classified;
}
