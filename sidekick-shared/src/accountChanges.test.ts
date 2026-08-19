import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _notifyAccountsChanged, onAccountsChanged } from './accountChanges';
import { writeSavedAccountRegistry } from './accountRegistry';
import { setConfigDir } from './paths';

describe('onAccountsChanged', () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    setConfigDir(null);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('emits process-local active-account mutations without host polling', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-change-'));
    setConfigDir(directory);
    // Hermetic HOME: a real ~/.claude live login would shadow the registry
    // and make the status independent of this test's mutations.
    vi.stubEnv('HOME', directory);
    const events: Array<{ reason: string; accountId?: string }> = [];
    const subscription = onAccountsChanged((event) => {
      events.push({ reason: event.reason, accountId: event.status.claude.accountId });
    });

    writeSavedAccountRegistry({
      version: 2,
      activeByProvider: { 'claude-code': 'claude-one', codex: null },
      accounts: [
        {
          id: 'claude-one',
          providerId: 'claude-code',
          addedAt: '2026-08-18T00:00:00.000Z',
          email: 'claude@example.com',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(events.some((event) => event.reason === 'local')).toBe(true);
    subscription.dispose();
  });

  it('does not wake subscribers on signals that carry no status change', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-change-'));
    setConfigDir(directory);
    vi.stubEnv('HOME', directory);
    const events: string[] = [];
    const subscription = onAccountsChanged((event) => {
      events.push(event.reason);
    });

    // Watched directories churn constantly (~/.claude and Codex history files
    // grow on every prompt), so a signal without an actual account-status
    // change must never reach subscribers — dormant quota pollers wake on it.
    _notifyAccountsChanged();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(events).toEqual([]);
    subscription.dispose();
  });
});
