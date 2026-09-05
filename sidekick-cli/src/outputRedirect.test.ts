import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { installOutputRedirect } from './outputRedirect';

describe('installOutputRedirect', () => {
  const originalWrite = process.stdout.write;
  const originalLevel = chalk.level;
  const dirs: string[] = [];

  afterEach(() => {
    process.stdout.write = originalWrite;
    chalk.level = originalLevel;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function scratchFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-redirect-'));
    dirs.push(dir);
    return path.join(dir, 'out.txt');
  }

  it('writes plain text to the file even when the terminal supports colour', () => {
    const file = scratchFile();
    chalk.level = 3;
    installOutputRedirect(file, {});
    process.stdout.write(chalk.red('hello') + '\n');
    process.stdout.write = originalWrite;

    expect(fs.readFileSync(file, 'utf8')).toBe('hello\n');
    expect(chalk.level).toBe(0);
  });

  it('keeps colour when FORCE_COLOR is set', () => {
    const file = scratchFile();
    chalk.level = 3;
    installOutputRedirect(file, { FORCE_COLOR: '1' });
    process.stdout.write(chalk.red('hello') + '\n');
    process.stdout.write = originalWrite;

    expect(fs.readFileSync(file, 'utf8')).toContain('\u001b[');
    expect(chalk.level).toBe(3);
  });
});
