import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onAccountsChanged } from './accountChanges';
import { writeSavedAccountRegistry } from './accountRegistry';
import { setConfigDir } from './paths';

describe('onAccountsChanged', () => {
  let directory: string | undefined;

  afterEach(() => {
    setConfigDir(null);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('emits process-local active-account mutations without host polling', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-change-'));
    setConfigDir(directory);
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
});
