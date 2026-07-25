import { describe, expect, it } from 'vitest';
import { needsFullStartup } from './startup';

describe('needsFullStartup', () => {
  it('skips the network fetch and account bootstrap for a bare invocation', () => {
    expect(needsFullStartup(undefined)).toBe(false);
  });

  it.each(['--help', '-h', '--version', '-V'])('skips flag-only invocation %s', (flag) => {
    // `sidekick --version` used to create ~/.config/sidekick/accounts/.
    expect(needsFullStartup(flag)).toBe(false);
  });

  it.each(['statusline', 'today'])('skips cache-only command %s', (command) => {
    // statusline runs on every shell prompt; it must stay local and fast.
    expect(needsFullStartup(command)).toBe(false);
  });

  it.each(['dashboard', 'stats', 'quota', 'tasks', 'account', 'doctor', 'search'])(
    'runs full startup for %s',
    (command) => {
      expect(needsFullStartup(command)).toBe(true);
    },
  );
});
