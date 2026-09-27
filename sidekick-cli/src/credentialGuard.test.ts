import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isClaudeProfileAuthenticated } from 'sidekick-shared';

interface GuardState {
  realHome: string;
  testHome: string;
  take(): string[];
}

const guard = (globalThis as unknown as { __sidekickCredentialGuard: GuardState })
  .__sidekickCredentialGuard;
const originalPlatform = process.platform;

describe('credential guard (self-test)', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    // This test trips the guard on purpose; drain so the global hook passes.
    guard.take();
  });

  it('is installed from sidekick-shared and redirects HOME', () => {
    expect(guard).toBeDefined();
    expect(os.homedir()).toBe(guard.testHome);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('catches sidekick-shared dist code reaching the real security binary', () => {
    // dist is CommonJS loaded through native require, which a per-file
    // vi.mock('child_process') cannot intercept; the guard patches the real
    // module object instead.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(isClaudeProfileAuthenticated(path.join(os.tmpdir(), 'guard-probe-home'))).toBe(false);
    expect(guard.take().some((v) => v.includes("'security'"))).toBe(true);
  });
});
