import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import * as path from 'path';
import {
  installCredentialGuard,
  type CredentialGuard,
  type CredentialGuardOptions,
} from './credentialGuard';

const GUARD_KEY = '__sidekickCredentialGuard';
const SCRUBBED = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CODEX_HOME',
  'SIDEKICK_CONFIG_DIR',
] as const;

const globals = globalThis as unknown as Record<string, unknown>;
// Installed by credentialGuard.setup.ts before this file runs.
const outer = globals[GUARD_KEY] as CredentialGuard;

/** Function-valued data properties of a module, restorable after a second install patches them. */
function snapshotModule(id: string): () => void {
  const module = process.getBuiltinModule(id) as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(module))) {
    if ('value' in descriptor && typeof descriptor.value === 'function')
      saved.set(key, descriptor.value);
  }
  return () => {
    for (const [key, value] of saved) if (module[key] !== value) module[key] = value;
  };
}

/**
 * Run a first install in this process: hide the setup-file guard, apply `env`,
 * call `installCredentialGuard(options)`, then restore the patched modules,
 * the environment, and the setup-file guard whatever happens.
 */
function freshInstall(
  env: Partial<Record<string, string>>,
  options: CredentialGuardOptions | undefined,
  inspect: (guard: CredentialGuard) => void,
): void {
  const restoreModules = ['node:fs', 'node:child_process'].map(snapshotModule);
  const savedEnv = { ...process.env };
  let installed: CredentialGuard | undefined;
  delete globals[GUARD_KEY];
  try {
    for (const name of SCRUBBED) delete process.env[name];
    Object.assign(process.env, env);
    installed = installCredentialGuard(options);
    inspect(installed);
  } finally {
    for (const restore of restoreModules) restore();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    globals[GUARD_KEY] = outer;
    if (installed) fs.rmSync(installed.testHome, { recursive: true, force: true });
  }
}

/** Expect a first install to throw, and to have changed nothing first. */
function expectRefused(
  env: Partial<Record<string, string>>,
  options: CredentialGuardOptions,
  message: RegExp,
): void {
  const spawn = (process.getBuiltinModule('node:child_process') as Record<string, unknown>).spawn;
  const writeFileSync = (process.getBuiltinModule('node:fs') as Record<string, unknown>)
    .writeFileSync;
  const home = process.env.HOME;
  expect(() =>
    freshInstall(env, options, () => {
      throw new Error('install should have been refused');
    }),
  ).toThrow(message);
  expect(process.env.HOME).toBe(home);
  expect((process.getBuiltinModule('node:child_process') as Record<string, unknown>).spawn).toBe(
    spawn,
  );
  expect((process.getBuiltinModule('node:fs') as Record<string, unknown>).writeFileSync).toBe(
    writeFileSync,
  );
}

function fixtureDir(name: string): string {
  const dir = path.join(outer.testHome, 'preserve-env-fixtures', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('installCredentialGuard preserveEnv', () => {
  it('keeps a preserved fixture variable and still unsets the others', () => {
    const config = fixtureDir('sidekick-config');
    const env = {
      SIDEKICK_CONFIG_DIR: config,
      CODEX_HOME: fixtureDir('codex'),
      CLAUDE_CONFIG_DIR: fixtureDir('claude'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: fixtureDir('claude-secure'),
    };
    freshInstall(env, { preserveEnv: ['SIDEKICK_CONFIG_DIR'] }, (guard) => {
      expect(process.env.SIDEKICK_CONFIG_DIR).toBe(config);
      expect(process.env.CODEX_HOME).toBeUndefined();
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      expect(process.env.HOME).toBe(guard.testHome);
    });
  });

  it('can preserve every home override', () => {
    const env = Object.fromEntries(SCRUBBED.map((name) => [name, fixtureDir(name.toLowerCase())]));
    freshInstall(env, { preserveEnv: SCRUBBED }, () => {
      for (const name of SCRUBBED) expect(process.env[name]).toBe(env[name]);
    });
  });

  it.each([undefined, {}, { preserveEnv: [] }])(
    'leaves the default behavior unchanged for %j',
    (options) => {
      const env = Object.fromEntries(SCRUBBED.map((name) => [name, fixtureDir(name)]));
      freshInstall(env, options, (guard) => {
        for (const name of SCRUBBED) expect(process.env[name]).toBeUndefined();
        expect(process.env.HOME).toBe(guard.testHome);
        expect(process.env.USERPROFILE).toBe(guard.testHome);
        expect(process.env.APPDATA).toBe(path.join(guard.testHome, 'AppData', 'Roaming'));
        expect(process.env.LOCALAPPDATA).toBe(path.join(guard.testHome, 'AppData', 'Local'));
      });
    },
  );

  it.each(['HOME', 'PATH', 'USERPROFILE', 'APPDATA', 'sidekick_config_dir', ''])(
    'refuses to preserve %j',
    (name) => {
      expectRefused({}, { preserveEnv: [name] }, /preserveEnv accepts only/);
    },
  );

  it.each([
    ['CLAUDE_CONFIG_DIR', ['.claude']],
    ['CLAUDE_CONFIG_DIR', ['.claude', 'nested', 'profile']],
    ['CLAUDE_SECURESTORAGE_CONFIG_DIR', ['.claude']],
    ['CLAUDE_CONFIG_DIR', ['.claude.json']],
    ['CODEX_HOME', ['.codex']],
    ['CODEX_HOME', ['.codex', 'sessions']],
    ['SIDEKICK_CONFIG_DIR', ['.config', 'sidekick']],
    ['SIDEKICK_CONFIG_DIR', ['.config', 'sidekick', 'accounts']],
    ['SIDEKICK_CONFIG_DIR', ['.config']],
    ['CLAUDE_CONFIG_DIR', []],
  ] as const)('refuses %s at the real home + %j', (name, segments) => {
    const value = path.join(outer.realHome, ...segments);
    expectRefused(
      { [name]: value },
      { preserveEnv: [name] },
      /reaches the real protected location/,
    );
    expect(outer.violations).toEqual([]);
  });

  it('refuses a preserved value inside a protectedPaths entry', () => {
    const protectedDir = fixtureDir('protected-extra');
    expectRefused(
      { CODEX_HOME: path.join(protectedDir, 'codex') },
      { preserveEnv: ['CODEX_HOME'], protectedPaths: [protectedDir] },
      /reaches the real protected location/,
    );
  });

  it.skipIf(process.platform === 'win32')('resolves symlinks before checking the location', () => {
    const protectedDir = fixtureDir('protected-target');
    const link = path.join(fixtureDir('links'), 'to-protected');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(protectedDir, link);
    expectRefused(
      { SIDEKICK_CONFIG_DIR: path.join(link, 'not-yet-created') },
      { preserveEnv: ['SIDEKICK_CONFIG_DIR'], protectedPaths: [protectedDir] },
      /reaches the real protected location/,
    );
  });

  it('keeps a blank preserved value without checking it', () => {
    freshInstall({ CODEX_HOME: '' }, { preserveEnv: ['CODEX_HOME'] }, () => {
      expect(process.env.CODEX_HOME).toBe('');
    });
  });

  it('ignores options once a guard is installed, as before', () => {
    expect(installCredentialGuard({ preserveEnv: ['PATH'] })).toBe(outer);
  });
});
