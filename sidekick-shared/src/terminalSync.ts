import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccountsDir, type AccountProviderId } from './accountRegistry';

const HOOK_START = '# >>> sidekick >>>';
const HOOK_END = '# <<< sidekick <<<';
const LAUNCHER_MARKER = '# sidekick-launcher v1';
const LAUNCHER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function providerPointerName(provider: AccountProviderId): 'claude' | 'codex' {
  return provider === 'claude-code' ? 'claude' : 'codex';
}

function providerEnvVar(provider: AccountProviderId): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return provider === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
}

function providerBinary(provider: AccountProviderId): 'claude' | 'codex' {
  return provider === 'claude-code' ? 'claude' : 'codex';
}

function getActiveProfilesDir(): string {
  return path.join(getAccountsDir(), 'active');
}

function getActiveProfilePath(provider: AccountProviderId): string {
  return path.join(getActiveProfilesDir(), `${providerPointerName(provider)}.profile`);
}

function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

export function setTerminalActiveProfile(provider: AccountProviderId, home: string | null): void {
  const pointerPath = getActiveProfilePath(provider);
  if (home === null) {
    fs.rmSync(pointerPath, { force: true });
    return;
  }
  atomicWriteFile(pointerPath, `${home}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildShellHookBlock(): string {
  const claudePointer = getActiveProfilePath('claude-code');
  const codexPointer = getActiveProfilePath('codex');
  return [
    HOOK_START,
    'sidekick_sync() {',
    `  if [ -r ${shellQuote(claudePointer)} ]; then export CLAUDE_CONFIG_DIR="$(cat ${shellQuote(claudePointer)})"; else unset CLAUDE_CONFIG_DIR; fi`,
    `  if [ -r ${shellQuote(codexPointer)} ]; then export CODEX_HOME="$(cat ${shellQuote(codexPointer)})"; else unset CODEX_HOME; fi`,
    '}',
    'sidekick_sync >/dev/null 2>&1',
    HOOK_END,
    '',
  ].join('\n');
}

function getShellRcPaths(): string[] {
  const zshrc = path.join(os.homedir(), '.zshrc');
  const bashrc = path.join(os.homedir(), '.bashrc');
  const paths = [zshrc];
  if (fs.existsSync(bashrc)) paths.push(bashrc);
  return paths;
}

function stripShellHook(content: string): string {
  const pattern = new RegExp(`${HOOK_START}[\\s\\S]*?${HOOK_END}\\n?`, 'g');
  return content.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
}

function installHookInFile(filePath: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const cleaned = stripShellHook(existing).replace(/\s*$/, '');
  const next = cleaned ? `${cleaned}\n\n${buildShellHookBlock()}` : buildShellHookBlock();
  atomicWriteFile(filePath, next, 0o600);
}

export function installShellHook(): void {
  for (const rcPath of getShellRcPaths()) {
    installHookInFile(rcPath);
  }
}

function uninstallHookInFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  atomicWriteFile(filePath, stripShellHook(fs.readFileSync(filePath, 'utf8')), 0o600);
}

export function uninstallShellHook(): void {
  for (const rcPath of getShellRcPaths()) {
    uninstallHookInFile(rcPath);
  }
}

export function isShellHookInstalled(): boolean {
  return getShellRcPaths().some((rcPath) => {
    try {
      const content = fs.readFileSync(rcPath, 'utf8');
      return content.includes(HOOK_START) && content.includes(HOOK_END);
    } catch {
      return false;
    }
  });
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
    `exec ${binary} "$@"`,
    '',
  ].join('\n');

  atomicWriteFile(launcherPath, script, 0o755);
}

export function removeLauncher(name: string): void {
  assertValidLauncherName(name);
  const launcherPath = getLauncherPath(name);
  if (!isSidekickLauncher(launcherPath)) return;
  fs.rmSync(launcherPath, { force: true });
}
