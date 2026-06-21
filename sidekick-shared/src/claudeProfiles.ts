import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getAccountsDir } from './accountRegistry';

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface ClaudeProfileIdentity {
  email: string;
  uuid: string;
}

export function getClaudeProfilesDir(): string {
  return path.join(getAccountsDir(), 'claude', 'profiles');
}

export function getClaudeProfileHome(uuid: string): string {
  return path.join(getClaudeProfilesDir(), uuid, 'home');
}

export function ensureClaudeProfileDirs(uuid: string): void {
  fs.mkdirSync(getClaudeProfileHome(uuid), { recursive: true, mode: 0o700 });
}

export function claudeKeychainSuffix(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

export function claudeKeychainService(configDir?: string): string {
  return configDir
    ? `${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}-${claudeKeychainSuffix(configDir)}`
    : DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
}

export function readClaudeProfileIdentity(home: string): ClaudeProfileIdentity | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const email = raw?.oauthAccount?.emailAddress;
    const uuid = raw?.oauthAccount?.accountUuid;
    return typeof email === 'string' && typeof uuid === 'string'
      ? { email, uuid }
      : null;
  } catch {
    return null;
  }
}

export function keychainServiceExists(service: string): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', service], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function isClaudeProfileAuthenticated(home: string): boolean {
  const hasCredentials = process.platform === 'darwin'
    ? keychainServiceExists(claudeKeychainService(home))
    : fs.existsSync(path.join(home, '.credentials.json'));

  return hasCredentials && readClaudeProfileIdentity(home) !== null;
}
