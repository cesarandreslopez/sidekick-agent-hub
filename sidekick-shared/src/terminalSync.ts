import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AccountProviderId } from './accountRegistry';
import { atomicWriteFileSync } from './writers/atomic';

const LAUNCHER_MARKER = '# sidekick-launcher v1';
const LAUNCHER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function providerEnvVar(provider: AccountProviderId): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return provider === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
}

function providerBinary(provider: AccountProviderId): 'claude' | 'codex' {
  return provider === 'claude-code' ? 'claude' : 'codex';
}

function getLauncherDir(): string {
  return path.join(os.homedir(), '.local', 'bin');
}

function getLauncherPath(name: string): string {
  return path.join(getLauncherDir(), name);
}

function assertValidLauncherName(name: string): void {
  if (!LAUNCHER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid launcher name "${name}". Use letters, numbers, underscores, and hyphens only.`,
    );
  }
}

function isSidekickLauncher(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
}

function assertNoLauncherCollision(name: string, targetPath: string): void {
  if (fs.existsSync(targetPath) && !isSidekickLauncher(targetPath)) {
    throw new Error(`Launcher "${name}" already exists and is not managed by sidekick.`);
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (path.resolve(candidate) === path.resolve(targetPath)) continue;
    if (fs.existsSync(candidate)) {
      throw new Error(`Launcher "${name}" collides with an existing command on PATH.`);
    }
  }
}

/**
 * Write a POSIX launcher script that runs the provider CLI against a profile
 * home. Unix only; on Windows use `sidekick accounts env --shell powershell`.
 */
export function writeLauncher(
  name: string,
  provider: AccountProviderId,
  profileHome: string,
): void {
  assertValidLauncherName(name);
  const launcherPath = getLauncherPath(name);
  assertNoLauncherCollision(name, launcherPath);

  const envVar = providerEnvVar(provider);
  const binary = providerBinary(provider);
  const script = [
    '#!/bin/sh',
    LAUNCHER_MARKER,
    `export ${envVar}=${JSON.stringify(profileHome)}`,
    ...(provider === 'claude-code' ? ['unset CLAUDE_SECURESTORAGE_CONFIG_DIR'] : []),
    `exec ${binary} "$@"`,
    '',
  ].join('\n');

  atomicWriteFileSync(launcherPath, script, 0o755);
}

export function removeLauncher(name: string): void {
  assertValidLauncherName(name);
  const launcherPath = getLauncherPath(name);
  if (!isSidekickLauncher(launcherPath)) return;
  fs.rmSync(launcherPath, { force: true });
}
