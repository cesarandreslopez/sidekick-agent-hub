import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock vscode module (pulled in transitively via PersistenceService)
vi.mock('vscode', () => ({
  Disposable: { from: vi.fn() },
}));

// Mock Logger
vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { ClaudeStatuslineInstaller } from './ClaudeStatuslineInstaller';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeStatuslineInstaller', () => {
  it('merges settings and restores the exact previous statusLine on uninstall', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-statusline-'));
    tempDirs.push(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const backupPath = path.join(dir, 'backup.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const previous = { type: 'command', command: 'old-footer --compact' };
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', statusLine: previous }));
    const installer = new ClaudeStatuslineInstaller(settingsPath, backupPath);

    expect(installer.install()).toEqual({ changed: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      statusLine: { type: 'command', command: 'sidekick statusline' },
    });
    expect(installer.install()).toEqual({ changed: false });
    expect(installer.uninstall()).toEqual({ changed: true, restored: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      statusLine: previous,
    });
  });

  it('refuses to install over an unparseable settings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-statusline-'));
    tempDirs.push(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const backupPath = path.join(dir, 'backup.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const corrupt = '{ "permissions": { "allow": ["Bash"] }, }';
    fs.writeFileSync(settingsPath, corrupt);
    const installer = new ClaudeStatuslineInstaller(settingsPath, backupPath);

    expect(() => installer.install()).toThrow(/invalid JSON/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(corrupt);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it('treats a missing or empty settings file as a fresh install', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-statusline-'));
    tempDirs.push(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const backupPath = path.join(dir, 'backup.json');
    const installer = new ClaudeStatuslineInstaller(settingsPath, backupPath);

    expect(installer.install()).toEqual({ changed: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      statusLine: { type: 'command', command: 'sidekick statusline' },
    });

    const emptyPath = path.join(dir, '.claude', 'settings-empty.json');
    fs.writeFileSync(emptyPath, '  \n');
    const emptyInstaller = new ClaudeStatuslineInstaller(
      emptyPath,
      path.join(dir, 'backup-empty.json'),
    );
    expect(emptyInstaller.install()).toEqual({ changed: true });
    expect(JSON.parse(fs.readFileSync(emptyPath, 'utf8'))).toEqual({
      statusLine: { type: 'command', command: 'sidekick statusline' },
    });
  });
});
