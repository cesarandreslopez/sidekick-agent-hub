/**
 * Credential guard for test runners, published as `sidekick-shared/testing`.
 *
 * No test may reach the real macOS `security` binary, the real `claude` /
 * `codex` CLIs, or the developer's real Claude, Codex, or Sidekick homes: a
 * stray keychain write copies a live refresh token, and Claude Code rotates
 * that token on every refresh, so a second copy is a login waiting to die.
 *
 * Three layers:
 * - `HOME` (and the Windows equivalents) point at a per-process temp dir,
 *   removed on exit, and the home overrides (`CLAUDE_CONFIG_DIR`,
 *   `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME`, `SIDEKICK_CONFIG_DIR`)
 *   are unset, so every `os.homedir()`-derived path is isolated structurally;
 * - the real `child_process` module object is patched, which reaches both ESM
 *   named imports (after `syncBuiltinESMExports`) and CommonJS code loaded
 *   through native `require`; per-file `vi.mock('child_process')` factories
 *   replace the module and never get here;
 * - the real `fs` module refuses writes under the real homes and records reads.
 *
 * Production code swallows most errors, so violations are also recorded;
 * call `assertNoViolations()` after each test (see `credentialGuard.setup.ts`
 * for a vitest wiring). Framework-free; the real modules come from
 * `process.getBuiltinModule` (Node 20.16+).
 *
 * @module testing/credentialGuard
 */
import * as os from 'node:os';
import * as path from 'node:path';

export interface CredentialGuard {
  /** The developer's real home, from the passwd entry. */
  readonly realHome: string;
  /** The temp directory `HOME` now points at. */
  readonly testHome: string;
  /** Violations recorded since the last `take()`. */
  readonly violations: string[];
  /** Drain and return the recorded violations. */
  take(): string[];
  /** Throw when anything reached real credentials or homes since the last check. */
  assertNoViolations(): void;
}

export interface CredentialGuardOptions {
  /** Binaries no child process may run (default `security`, `claude`, `codex`). */
  blockedBinaries?: string[];
  /** Extra real paths to protect, besides the Claude, Codex, and Sidekick homes. */
  protectedPaths?: string[];
}

type AnyFn = (...args: unknown[]) => unknown;

const GUARD_KEY = '__sidekickCredentialGuard';
const DEFAULT_BLOCKED_BINARIES = ['security', 'claude', 'codex'];
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

/**
 * Installs the guard once per process and returns it; later calls return the
 * same guard and ignore their options.
 */
export function installCredentialGuard(options: CredentialGuardOptions = {}): CredentialGuard {
  const existing = (globalThis as Record<string, unknown>)[GUARD_KEY] as
    | CredentialGuard
    | undefined;
  if (existing) return existing;

  const childProcess = process.getBuiltinModule('node:child_process') as unknown as Record<
    string,
    AnyFn
  >;
  const realFs = process.getBuiltinModule('node:fs');
  const fs = realFs as unknown as Record<string, AnyFn>;
  const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
  const blockedBinaries = new Set(
    (options.blockedBinaries ?? DEFAULT_BLOCKED_BINARIES).map((name) => name.toLowerCase()),
  );

  // os.userInfo() reads the passwd entry, so it still names the real home
  // after HOME is redirected below.
  const realHome = os.userInfo().homedir;
  const testHome = realFs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-test-home-'));

  const removeTestHome = realFs.rmSync.bind(realFs);
  process.once('exit', () => {
    try {
      removeTestHome(testHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  const state: CredentialGuard = {
    realHome,
    testHome,
    violations: [],
    take() {
      return state.violations.splice(0, state.violations.length);
    },
    assertNoViolations() {
      const violations = state.take();
      if (violations.length > 0) {
        throw new Error(
          `Credential guard: this test reached real credentials or homes:\n- ${violations.join('\n- ')}`,
        );
      }
    },
  };

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.APPDATA = path.join(testHome, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(testHome, 'AppData', 'Local');
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.SIDEKICK_CONFIG_DIR;

  const protectedRoots =
    path.resolve(realHome) === path.resolve(testHome)
      ? []
      : [
          path.join(realHome, '.claude'),
          path.join(realHome, '.claude.json'),
          path.join(realHome, '.codex'),
          path.join(realHome, '.config', 'sidekick'),
          ...(options.protectedPaths ?? []),
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
      if (blockedBinaries.has(binary)) {
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
