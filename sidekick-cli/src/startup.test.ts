import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => ({})),
  hydrate: vi.fn(async () => ({})),
  observed: vi.fn(async () => ({})),
}));
vi.mock('sidekick-shared', () => ({ ensureDefaultAccounts: calls.bootstrap }));
vi.mock('sidekick-shared/node', () => ({
  hydratePricingCatalog: calls.hydrate,
  loadObservedContextWindows: calls.observed,
}));
import { needsFullStartup, runStartupSideEffects, _resetStartupForTests } from './startup';

describe('needsFullStartup', () => {
  it('skips the network fetch and account bootstrap for a bare invocation', () => {
    expect(needsFullStartup(undefined)).toBe(false);
  });

  it.each(['--help', '-h', '--version', '-V'])('skips flag-only invocation %s', (flag) => {
    // `sidekick --version` used to create ~/.config/sidekick/accounts/.
    expect(needsFullStartup(flag)).toBe(false);
  });

  it.each(['statusline', 'today', 'history'])('skips cache-only command %s', (command) => {
    // statusline runs on every shell prompt; it must stay local and fast.
    // history reads only local files, so it needs no pricing or accounts.
    expect(needsFullStartup(command)).toBe(false);
  });

  it.each(['dashboard', 'stats', 'quota', 'tasks', 'account', 'doctor', 'search'])(
    'runs full startup for %s',
    (command) => {
      expect(needsFullStartup(command)).toBe(true);
    },
  );
});

describe('account doctor startup (I4)', () => {
  it.each(['accounts', 'account'])(
    'does not bootstrap or hydrate before %s doctor, including --fix confirmation',
    async (command) => {
      _resetStartupForTests();
      for (const fn of Object.values(calls)) fn.mockClear();
      await runStartupSideEffects(command, { accountDoctor: true });
      expect(calls.bootstrap).not.toHaveBeenCalled();
      expect(calls.hydrate).not.toHaveBeenCalled();
      expect(calls.observed).not.toHaveBeenCalled();
    },
  );
});
