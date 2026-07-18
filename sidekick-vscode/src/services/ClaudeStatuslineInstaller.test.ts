import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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
});
