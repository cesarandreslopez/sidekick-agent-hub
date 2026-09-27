import { afterEach, describe, expect, it, vi } from 'vitest';
import { exec, execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
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
});
