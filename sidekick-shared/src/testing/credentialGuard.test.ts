import { afterEach, describe, expect, it, vi } from 'vitest';
import { exec, execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { keychainServiceExists } from '../claudeProfiles';

interface GuardState {
  realHome: string;
  testHome: string;
  take(): string[];
}

const guard = (globalThis as unknown as { __sidekickCredentialGuard: GuardState })
  .__sidekickCredentialGuard;

describe('credential guard (self-test)', () => {
  afterEach(() => {
    // These tests trip the guard on purpose; drain so the global hook passes.
    guard.take();
  });

  it('is installed and redirects HOME away from the real home', () => {
    expect(guard).toBeDefined();
    expect(os.homedir()).toBe(guard.testHome);
    expect(os.homedir()).not.toBe(guard.realHome);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it('blocks security through an ESM named import', () => {
    expect(() => execFileSync('security', ['help'])).toThrow(/credential guard/);
    expect(guard.take()).toHaveLength(1);
  });

  it('blocks security through a CommonJS require (the path dist code takes)', () => {
    const childProcess = createRequire(import.meta.url)(
      'child_process',
    ) as typeof import('child_process');
    expect(() => childProcess.spawnSync('security', ['help'])).toThrow(/credential guard/);
    expect(() => childProcess.execFileSync('/usr/bin/security', ['help'])).toThrow(
      /credential guard/,
    );
  });

  it('blocks security through an importActual spread', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const spread = { ...actual };
    expect(() => spread.execFileSync('security', ['help'])).toThrow(/credential guard/);
  });

  it('blocks claude and codex, including the string form of exec', () => {
    expect(() => exec('claude auth status')).toThrow(/credential guard/);
    expect(() => execFileSync('codex', ['login', 'status'])).toThrow(/credential guard/);
  });

  it('records a violation even when production code swallows the error', () => {
    // keychainServiceExists catches every throw and returns false; the record
    // is what lets the global afterEach fail such a test.
    expect(keychainServiceExists('Claude Code-credentials-guardtest')).toBe(false);
    expect(guard.take().some((v) => v.includes("'security'"))).toBe(true);
  });

  it('refuses writes inside the real home before they happen', () => {
    const target = path.join(guard.realHome, '.claude', 'sidekick-guard-probe');
    expect(() => fs.writeFileSync(target, 'x')).toThrow(/credential guard/);
    expect(guard.take()).toHaveLength(1);
  });

  it('lets ordinary binaries through', () => {
    expect(String(execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")']))).toBe('ok');
    expect(guard.take()).toEqual([]);
  });

  it('keeps the promisified { stdout, stderr } contract of execFile and exec', async () => {
    const fromExecFile = promisify(execFile)(process.execPath, [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(fromExecFile.child.pid).toEqual(expect.any(Number));
    expect(await fromExecFile).toEqual({ stdout: 'ok', stderr: '' });

    const fromExec = await promisify(exec)(`"${process.execPath}" -e "process.stdout.write('ok')"`);
    expect(fromExec).toEqual({ stdout: 'ok', stderr: '' });
    expect(guard.take()).toEqual([]);
  });

  it('rejects a failing promisified call with stdout and stderr on the error', async () => {
    await expect(
      promisify(execFile)(process.execPath, [
        '-e',
        'process.stdout.write("x"); process.stderr.write("y"); process.exit(3)',
      ]),
    ).rejects.toMatchObject({ code: 3, stdout: 'x', stderr: 'y' });
    expect(guard.take()).toEqual([]);
  });

  it('blocks claude and codex through the promisified calls', async () => {
    await expect(promisify(execFile)('codex', ['login', 'status'])).rejects.toThrow(
      /credential guard/,
    );
    await expect(promisify(exec)('claude auth status')).rejects.toThrow(/credential guard/);
    const childProcess = createRequire(import.meta.url)(
      'child_process',
    ) as typeof import('child_process');
    await expect(promisify(childProcess.execFile)('security', ['help'])).rejects.toThrow(
      /credential guard/,
    );
    expect(guard.take()).toHaveLength(3);
  });
});
