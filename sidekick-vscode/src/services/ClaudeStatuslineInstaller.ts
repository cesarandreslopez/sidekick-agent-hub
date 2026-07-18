import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface StatuslineBackup {
  version: 1;
  hadStatusLine: boolean;
  statusLine?: unknown;
}

const SIDEKICK_STATUSLINE = { type: 'command', command: 'sidekick statusline' } as const;

export class ClaudeStatuslineInstaller {
  constructor(
    private readonly settingsPath = path.join(os.homedir(), '.claude', 'settings.json'),
    private readonly backupPath = path.join(
      os.homedir(),
      '.config',
      'sidekick',
      'claude-statusline-backup.json',
    ),
  ) {}

  install(): { changed: boolean } {
    const settings = this.readJson(this.settingsPath);
    if (isSidekickStatusline(settings.statusLine)) return { changed: false };

    if (!fs.existsSync(this.backupPath)) {
      const backup: StatuslineBackup = {
        version: 1,
        hadStatusLine: Object.prototype.hasOwnProperty.call(settings, 'statusLine'),
        statusLine: settings.statusLine,
      };
      this.atomicWrite(this.backupPath, backup);
    }

    settings.statusLine = SIDEKICK_STATUSLINE;
    this.atomicWrite(this.settingsPath, settings);
    return { changed: true };
  }

  uninstall(): { changed: boolean; restored: boolean } {
    const settings = this.readJson(this.settingsPath);
    const backup = this.readBackup();
    if (backup?.hadStatusLine) settings.statusLine = backup.statusLine;
    else delete settings.statusLine;

    const changed = isSidekickStatusline(this.readJson(this.settingsPath).statusLine);
    if (changed) this.atomicWrite(this.settingsPath, settings);
    try {
      fs.unlinkSync(this.backupPath);
    } catch {
      // Missing backup is fine.
    }
    return { changed, restored: backup?.hadStatusLine === true };
  }

  private readBackup(): StatuslineBackup | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.backupPath, 'utf8')) as StatuslineBackup;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  private readJson(filePath: string): Record<string, unknown> {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private atomicWrite(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best effort.
      }
      throw error;
    }
  }
}

function isSidekickStatusline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === 'command' && record.command === SIDEKICK_STATUSLINE.command;
}
