/**
 * Global test guard, loaded through `setupFiles` by all three packages.
 *
 * No test may reach the real macOS `security` binary, the real `claude` /
 * `codex` CLIs, or the developer's real Claude, Codex, or Sidekick homes: a
 * stray keychain write copies a live refresh token, and Claude Code rotates
 * that token on every refresh, so a second copy is a login waiting to die.
 *
 * Three layers:
 * - `HOME` (and the Windows equivalents) point at a per-worker temp dir and the
 *   config-dir overrides are unset, so every `os.homedir()`-derived path is
 *   isolated structurally;
 * - the real `child_process` module object is patched, which reaches both ESM
 *   named imports (after `syncBuiltinESMExports`) and `sidekick-shared/dist`
 *   code loaded through native `require`; per-file `vi.mock('child_process')`
 *   factories replace the module and never get here;
 * - the real `fs` module refuses writes under the real homes and records reads.
 *
 * Production code swallows most errors (`keychainServiceExists` returns false
 * on any throw), so violations are also recorded and fail the test in a global
 * `afterEach`. Imports nothing from vitest on purpose: the CLI and VS Code
 * packages would resolve a second copy from this directory. It relies on
 * `globals: true` instead.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

declare const afterEach: (fn: () => void) => void;

interface CredentialGuardState {
  realHome: string;
  testHome: string;
  violations: string[];
  /** Drain recorded violations (the guard's own self-tests use this). */
  take(): string[];
}

type AnyFn = (...args: unknown[]) => unknown;

const GUARD_KEY = '__sidekickCredentialGuard';
const BLOCKED_BINARIES = new Set(['security', 'claude', 'codex']);
const CHILD_PROCESS_FUNCTIONS = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
] as const;
const FS_WRITE_FUNCTIONS = [
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'copyFileSync',
  'cpSync',
  'chmodSync',
  'symlinkSync',
] as const;
const FS_READ_FUNCTIONS = [
  'readFileSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'openSync',
  'watch',
] as const;

const nodeRequire = createRequire(import.meta.url);

function installGuard(): CredentialGuardState {
  const existing = (globalThis as Record<string, unknown>)[GUARD_KEY] as
    | CredentialGuardState
    | undefined;
  if (existing) return existing;

  const childProcess = nodeRequire('node:child_process') as Record<string, AnyFn>;
  const fs = nodeRequire('node:fs') as Record<string, AnyFn> & typeof import('node:fs');

  // os.userInfo() reads the passwd entry, so it still names the real home
  // after HOME is redirected below.
  const realHome = os.userInfo().homedir;
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-test-home-'));

  const state: CredentialGuardState = {
    realHome,
    testHome,
    violations: [],
    take() {
      return state.violations.splice(0, state.violations.length);
    },
  };

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.APPDATA = path.join(testHome, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(testHome, 'AppData', 'Local');
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete process.env.CODEX_HOME;

  const protectedRoots =
    path.resolve(realHome) === path.resolve(testHome)
      ? []
      : [
          path.join(realHome, '.claude'),
          path.join(realHome, '.claude.json'),
          path.join(realHome, '.codex'),
          path.join(realHome, '.config', 'sidekick'),
        ];

  const isProtected = (target: unknown): string | null => {
    let candidate: string | null = null;
    if (typeof target === 'string') candidate = target;
    else if (target instanceof URL && target.protocol === 'file:') candidate = target.pathname;
    if (!candidate) return null;
    const resolved = path.resolve(candidate);
    return protectedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
      ? resolved
      : null;
  };

  const binaryName = (command: unknown): string => {
    if (typeof command !== 'string') return '';
    const first = command.trim().split(/\s+/)[0] ?? '';
    return path
      .basename(first.replace(/^["']|["']$/g, ''))
      .replace(/\.(exe|cmd|bat)$/i, '')
      .toLowerCase();
  };

  const record = (message: string): never => {
    state.violations.push(message);
    throw new Error(`[credential guard] ${message}`);
  };

  for (const name of CHILD_PROCESS_FUNCTIONS) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function guarded(this: unknown, ...args: unknown[]) {
      const binary = binaryName(args[0]);
      if (BLOCKED_BINARIES.has(binary)) {
        record(
          `child_process.${name}('${binary}') reached the real binary; mock child_process or inject a runner`,
        );
      }
      return original.apply(this, args);
    } as AnyFn;
  }

  for (const name of FS_WRITE_FUNCTIONS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function guarded(this: unknown, ...args: unknown[]) {
      for (const arg of args.slice(0, 2)) {
        const hit = isProtected(arg);
        if (hit) record(`fs.${name}(${hit}) would write inside the real home`);
      }
      return original.apply(this, args);
    } as AnyFn;
  }

  for (const name of FS_READ_FUNCTIONS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function guarded(this: unknown, ...args: unknown[]) {
      const hit = isProtected(args[0]);
      // Reads are recorded rather than thrown so existsSync keeps its
      // never-throws contract; the afterEach below still fails the test.
      if (hit) state.violations.push(`fs.${name}(${hit}) read the real home`);
      return original.apply(this, args);
    } as AnyFn;
  }

  syncBuiltinESMExports();
  (globalThis as Record<string, unknown>)[GUARD_KEY] = state;
  return state;
}

const guard = installGuard();

afterEach(() => {
  const violations = guard.take();
  if (violations.length > 0) {
    throw new Error(
      `Credential guard: this test reached real credentials or homes:\n- ${violations.join('\n- ')}`,
    );
  }
});
