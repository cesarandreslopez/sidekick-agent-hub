/**
 * Cross-platform detection of running CLI/app processes that hold provider
 * credentials in memory. Bounded, never throws, never spawns a shell.
 */
import { execFile, spawnSync } from 'child_process';
import * as path from 'path';

export interface RunningProcess {
  pid: number;
  /** The matched name (as passed to the finder). */
  name: string;
  /** The executable as reported by the OS (basename or image name). */
  command: string;
}

export type AccountConsumerKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'codex-cli'
  | 'codex-app'
  | 'vscode-extension-host';

export interface RunningAccountConsumer {
  kind: AccountConsumerKind;
  pids: number[];
  /** Whether a live-store switch reaches this consumer once it restarts. */
  switched: boolean;
  /** The user-facing sentence both UIs print for this consumer. */
  reachability: string;
}

const PROBE_TIMEOUT_MS = 4000;
const CLAUDE_NPM_ENTRY = /claude-code[\\/]cli\.js/;

interface ProcessRow {
  pid: number;
  command: string;
  args: string;
}

function parseUnixTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), command: match[2], args: match[3] ?? '' });
  }
  return rows;
}

function parseWindowsCsv(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    rows.push({ pid: Number(match[2]), command: match[1], args: '' });
  }
  return rows;
}

function matchRows(rows: ProcessRow[], names: string[]): RunningProcess[] {
  const wanted = new Set(names);
  const found: RunningProcess[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.pid) || row.pid === process.pid) continue;
    const base = path.basename(row.command);
    // The native Claude Code binary is invoked through a `claude` symlink but
    // its executable is the versioned file (`.../versions/2.1.273`), so `comm`
    // never says `claude`; argv[0] does.
    const argv0 = row.args.trim().split(/\s+/)[0] ?? '';
    const candidates = [base, base.replace(/\.exe$/i, ''), path.basename(argv0)];
    let name = candidates.find((candidate) => candidate && wanted.has(candidate));
    // An npm-installed `claude` runs under `node`; recognise it by its entry file.
    if (
      !name &&
      wanted.has('claude') &&
      /^node(\.exe)?$/i.test(base) &&
      CLAUDE_NPM_ENTRY.test(row.args)
    ) {
      name = 'claude';
    }
    if (name) found.push({ pid: row.pid, name, command: row.command });
  }
  return found;
}

function probeCommand(): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: 'tasklist', args: ['/FO', 'CSV', '/NH'] }
    : { command: 'ps', args: ['-axo', 'pid=,comm=,args='] };
}

function parseOutput(stdout: string): ProcessRow[] {
  return process.platform === 'win32' ? parseWindowsCsv(stdout) : parseUnixTable(stdout);
}

/** Sync sibling of {@link findRunningProcesses}; blocks up to 4 s. */
export function findRunningProcessesSync(names: string[]): RunningProcess[] {
  if (names.length === 0) return [];
  try {
    const { command, args } = probeCommand();
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return [];
    return matchRows(parseOutput(String(result.stdout ?? '')), names);
  } catch {
    return [];
  }
}

export function findRunningProcesses(names: string[]): Promise<RunningProcess[]> {
  if (names.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const { command, args } = probeCommand();
      execFile(
        command,
        args,
        {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) => {
          resolve(error ? [] : matchRows(parseOutput(String(stdout ?? '')), names));
        },
      );
    } catch {
      resolve([]);
    }
  });
}

const CONSUMER_PROCESS_NAMES: Record<
  Exclude<AccountConsumerKind, 'vscode-extension-host'>,
  string
> = {
  'claude-cli': 'claude',
  'claude-desktop': 'Claude',
  'codex-cli': 'codex',
  'codex-app': 'Codex',
};

export const ACCOUNT_CONSUMER_REACHABILITY: Record<
  AccountConsumerKind,
  { switched: boolean; reachability: string }
> = {
  'claude-cli': {
    switched: true,
    reachability:
      'Running claude sessions keep the previous account until restarted; a running session can rotate the refresh token of the account you just left.',
  },
  'claude-desktop': {
    switched: false,
    reachability:
      'Claude Desktop is not switched by sidekick (it keeps its own web session) and its embedded engine can rotate the shared CLI token.',
  },
  'codex-cli': {
    switched: true,
    reachability: 'Running codex sessions keep the previous account until restarted.',
  },
  'codex-app': {
    switched: true,
    reachability:
      'The Codex app shares the CLI login; restart it to pick up the switch. While running it can refresh and rotate the live token.',
  },
  'vscode-extension-host': {
    switched: true,
    reachability:
      'The Claude Code extension host keeps the previous account until the window reloads.',
  },
};

function toConsumer(kind: AccountConsumerKind, pids: number[]): RunningAccountConsumer {
  return { kind, pids, ...ACCOUNT_CONSUMER_REACHABILITY[kind] };
}

function groupConsumers(
  processes: RunningProcess[],
  kinds: Array<Exclude<AccountConsumerKind, 'vscode-extension-host'>>,
): RunningAccountConsumer[] {
  const consumers: RunningAccountConsumer[] = [];
  for (const kind of kinds) {
    const pids = processes.filter((p) => p.name === CONSUMER_PROCESS_NAMES[kind]).map((p) => p.pid);
    if (pids.length > 0) consumers.push(toConsumer(kind, pids));
  }
  return consumers;
}

function kindsForProvider(
  provider?: 'claude-code' | 'codex',
): Array<Exclude<AccountConsumerKind, 'vscode-extension-host'>> {
  if (provider === 'claude-code') return ['claude-cli', 'claude-desktop'];
  if (provider === 'codex') return ['codex-cli', 'codex-app'];
  return ['claude-cli', 'claude-desktop', 'codex-cli', 'codex-app'];
}

/**
 * Which credential consumers are running right now, with the reachability
 * sentence to show for each. Optionally scoped to one provider.
 */
export async function detectRunningAccountConsumers(
  provider?: 'claude-code' | 'codex',
): Promise<RunningAccountConsumer[]> {
  const kinds = kindsForProvider(provider);
  const processes = await findRunningProcesses(kinds.map((kind) => CONSUMER_PROCESS_NAMES[kind]));
  return groupConsumers(processes, kinds);
}

/** Sync sibling of {@link detectRunningAccountConsumers}; blocks up to 4 s. */
export function detectRunningAccountConsumersSync(
  provider?: 'claude-code' | 'codex',
): RunningAccountConsumer[] {
  const kinds = kindsForProvider(provider);
  const processes = findRunningProcessesSync(kinds.map((kind) => CONSUMER_PROCESS_NAMES[kind]));
  return groupConsumers(processes, kinds);
}

/** Build a consumer entry for a kind the host detects itself (e.g. its own extension host). */
export function describeAccountConsumer(
  kind: AccountConsumerKind,
  pids: number[] = [],
): RunningAccountConsumer {
  return toConsumer(kind, pids);
}
