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
 *   are unset (unless named in `preserveEnv` and pointed at a fixture), so
 *   every `os.homedir()`-derived path is isolated structurally;
 * - the real `child_process` module object is patched, which reaches both ESM
 *   named imports (after `syncBuiltinESMExports`) and CommonJS code loaded
 *   through native `require`; per-file `vi.mock('child_process')` factories
 *   replace the module and never get here;
 * - the real `fs` module refuses writes under the real homes and records reads.
 *
 * Production code swallows most errors, so violations are also recorded;
 * call `assertNoViolations()` after each test (see `credentialGuard.setup.ts`
 * for a vitest wiring). Framework-free; the real modules come from
 * `process.getBuiltinModule` (Node 20.16+), or `require` in CommonJS.
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
  /**
   * Home overrides to keep instead of unsetting, for a suite that points one
   * at its own fixture before the guard installs. Accepts only the variables
   * the guard unsets: `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
   * `CODEX_HOME`, and `SIDEKICK_CONFIG_DIR`.
   *
   * Install throws, before changing anything, for any other name, or when a
   * preserved value is, contains, or lies inside a real protected location:
   * the real home's `.claude`, `.claude.json`, and `.codex`, the default
   * Sidekick config dir, or a `protectedPaths` entry. Symlinks are resolved
   * first. The guard cannot tell a real store kept elsewhere from a fixture,
   * so preserve only paths the suite created. Blank values are kept unchecked.
   */
  preserveEnv?: readonly string[];
}

type AnyFn = (...args: unknown[]) => unknown;

const GUARD_KEY = '__sidekickCredentialGuard';
const DEFAULT_BLOCKED_BINARIES = ['security', 'claude', 'codex'];
/** Home overrides the guard unsets; only these can be preserved. */
const SCRUBBED_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CODEX_HOME',
  'SIDEKICK_CONFIG_DIR',
] as const;
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

  const childProcess = builtin<typeof import('node:child_process')>(
    'node:child_process',
  ) as unknown as Record<string, AnyFn>;
  const realFs = builtin<typeof import('node:fs')>('node:fs');
  const fs = realFs as unknown as Record<string, AnyFn>;
  const { syncBuiltinESMExports } = builtin<typeof import('node:module')>('node:module');
  const { promisify } = builtin<typeof import('node:util')>('node:util');
  const blockedBinaries = new Set(
    (options.blockedBinaries ?? DEFAULT_BLOCKED_BINARIES).map((name) => name.toLowerCase()),
  );

  // os.userInfo() reads the passwd entry, so it still names the real home
  // after HOME is redirected below.
  const realHome = os.userInfo().homedir;
  // Validated before any side effect, so a refused install changes nothing.
  const preserved = checkPreservedEnv(options, realHome, realFs);
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
  for (const name of SCRUBBED_ENV) if (!preserved.has(name)) delete process.env[name];

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
    const check = (args: unknown[]): void => {
      const binary = binaryName(args[0]);
      if (blockedBinaries.has(binary)) {
        record(
          `child_process.${name}('${binary}') reached the real binary; mock child_process or inject a runner`,
        );
      }
    };
    const guarded = function guarded(this: unknown, ...args: unknown[]) {
      check(args);
      return original.apply(this, args);
    } as AnyFn;
    // execFile and exec carry Node's promisify.custom, which resolves to
    // { stdout, stderr }; without it promisify() falls back to the first
    // callback value. Guard it too and delegate, so .child, the error's
    // stdout/stderr, encoding, and maxBuffer stay Node's own.
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(guarded, promisify.custom, {
        configurable: true,
        writable: true,
        value: function guardedPromisified(this: unknown, ...args: unknown[]) {
          try {
            check(args);
          } catch (error) {
            return Promise.reject(error);
          }
          return custom.apply(this, args);
        },
      });
    }
    childProcess[name] = guarded;
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

/** The `preserveEnv` names, after refusing unknown names and unsafe values. */
function checkPreservedEnv(
  options: CredentialGuardOptions,
  realHome: string,
  realFs: typeof import('node:fs'),
): Set<string> {
  const preserved = new Set<string>();
  for (const name of options.preserveEnv ?? []) {
    if (!(SCRUBBED_ENV as readonly unknown[]).includes(name)) {
      throw new Error(
        `installCredentialGuard: preserveEnv accepts only ${SCRUBBED_ENV.join(', ')}; got ${JSON.stringify(name)}.`,
      );
    }
    preserved.add(name);
  }
  if (preserved.size === 0) return preserved;

  const roots = [
    path.join(realHome, '.claude'),
    path.join(realHome, '.claude.json'),
    path.join(realHome, '.codex'),
    path.join(realHome, '.config', 'sidekick'),
    // The Windows default config dir, read before HOME and APPDATA move.
    ...(process.platform === 'win32' && process.env.APPDATA
      ? [path.join(process.env.APPDATA, 'sidekick')]
      : []),
    ...(options.protectedPaths ?? []),
  ];
  for (const name of preserved) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    const hit = protectedLocation(value, roots, realFs);
    if (hit) {
      throw new Error(
        `installCredentialGuard: preserveEnv ${name}=${value} reaches the real protected location ${hit}. Point it at a temporary fixture instead.`,
      );
    }
  }
  return preserved;
}

/** The root `target` equals, contains, or lies inside, comparing plain and symlink-resolved paths. */
function protectedLocation(
  target: string,
  roots: readonly string[],
  realFs: typeof import('node:fs'),
): string | null {
  // Case-insensitive by default on macOS and Windows; folding can only over-refuse.
  const fold = process.platform === 'darwin' || process.platform === 'win32';
  const normal = (value: string): string => {
    const resolved = path.resolve(value);
    return fold ? resolved.toLowerCase() : resolved;
  };
  const within = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const related = (a: string, b: string): boolean => within(a, b) || within(b, a);

  // Plain paths first, so an obviously unsafe value never reaches the filesystem.
  const plain = normal(target);
  for (const root of roots) if (related(normal(root), plain)) return root;
  const real = normal(realpathOfNearest(target, realFs));
  for (const root of roots) {
    const realRoot = normal(realpathOfNearest(root, realFs));
    if (related(realRoot, real) || related(normal(root), real) || related(realRoot, plain))
      return root;
  }
  return null;
}

/** `realpath` of the nearest existing ancestor, with the missing tail re-appended. */
function realpathOfNearest(target: string, realFs: typeof import('node:fs')): string {
  let current = path.resolve(target);
  let tail: string[] = [];
  for (;;) {
    try {
      return path.join(realFs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail = [path.basename(current), ...tail];
      current = parent;
    }
  }
}

/**
 * The real module object of a Node built-in: `process.getBuiltinModule`
 * (Node 20.16+), or `require` in CommonJS on older Node.
 */
function builtin<T>(id: string): T {
  if (typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(id) as T;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS fallback for Node < 20.16
  if (typeof require === 'function') return require(id) as T;
  throw new Error('installCredentialGuard() needs Node 20.16+ outside CommonJS.');
}
