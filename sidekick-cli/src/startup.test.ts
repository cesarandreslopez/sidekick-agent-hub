import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => ({})),
  hydrate: vi.fn(async () => ({
    source: 'cache',
    entries: 10,
    contextWindowEntries: 0,
    fetchedAt: '2026-11-01T00:00:00.000Z',
    digest: 'fnv1a64:0000000000000001',
  })),
  observed: vi.fn(async () => ({})),
  register: vi.fn(),
}));
const configDir = vi.hoisted(() => ({ value: '' }));
vi.mock('sidekick-shared', () => ({
  ensureDefaultAccounts: calls.bootstrap,
  getConfigDir: () => configDir.value,
}));
vi.mock('sidekick-shared/node', () => ({
  hydratePricingCatalog: calls.hydrate,
  loadObservedContextWindows: calls.observed,
  registerModelPricing: calls.register,
}));
import {
  applyConfiguredPricing,
  needsFullStartup,
  runStartupSideEffects,
  _resetStartupForTests,
} from './startup';
import {
  _resetPricingBasisForTests,
  getConfiguredPricing,
  getPricingHydration,
} from './pricingBasis';

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
      expect(calls.register).not.toHaveBeenCalled();
    },
  );
});

describe('custom prices from cli-config.json', () => {
  let stderr: string;

  beforeEach(() => {
    configDir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-startup-'));
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    _resetStartupForTests();
    _resetPricingBasisForTests();
    for (const fn of Object.values(calls)) fn.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(configDir.value, { recursive: true, force: true });
  });

  const writeConfig = (config: unknown) =>
    fs.writeFileSync(path.join(configDir.value, 'cli-config.json'), JSON.stringify(config));

  it('registers valid prices before hydrating, warns about invalid ones, and records both', async () => {
    writeConfig({
      pricing: {
        onlyIfMissing: true,
        models: {
          'my-model': { inputCostPerMillion: 2, outputCostPerMillion: 8 },
          broken: { inputCostPerMillion: -2, outputCostPerMillion: 8 },
        },
      },
    });
    await runStartupSideEffects('daily');

    expect(calls.register).toHaveBeenCalledOnce();
    expect(calls.register).toHaveBeenCalledWith(
      {
        'my-model': {
          inputCostPerMillion: 2,
          outputCostPerMillion: 8,
          cacheWriteCostPerMillion: 2,
          cacheReadCostPerMillion: 2,
        },
      },
      { onlyIfMissing: true },
    );
    expect(calls.register.mock.invocationCallOrder[0]).toBeLessThan(
      calls.hydrate.mock.invocationCallOrder[0],
    );
    expect(stderr).toContain('Warning: cli-config.json pricing.models["broken"]');
    expect(getConfiguredPricing()).toMatchObject({ entries: 1, onlyIfMissing: true });
    expect(getConfiguredPricing().warnings).toHaveLength(1);
    expect(getPricingHydration()).toMatchObject({
      state: 'done',
      offline: false,
      result: { source: 'cache', digest: 'fnv1a64:0000000000000001' },
    });
  });

  it('registers nothing without a pricing section and never for cache-only commands', async () => {
    await runStartupSideEffects('blocks');
    expect(calls.register).not.toHaveBeenCalled();
    expect(stderr).toBe('');

    _resetStartupForTests();
    _resetPricingBasisForTests();
    writeConfig({
      pricing: { models: { m: { inputCostPerMillion: 1, outputCostPerMillion: 1 } } },
    });
    await runStartupSideEffects('statusline');
    expect(calls.register).not.toHaveBeenCalled();
    expect(getPricingHydration()).toEqual({ state: 'not-run' });
  });

  it('records a failed hydration, and a broken registry never fails startup', async () => {
    calls.hydrate.mockRejectedValueOnce(new Error('boom'));
    await runStartupSideEffects('sessions');
    expect(getPricingHydration()).toEqual({ state: 'failed' });

    writeConfig({
      pricing: { models: { m: { inputCostPerMillion: 1, outputCostPerMillion: 1 } } },
    });
    calls.register.mockImplementationOnce(() => {
      throw new Error('registry unavailable');
    });
    const lines: string[] = [];
    expect(() => applyConfiguredPricing((text) => lines.push(text))).not.toThrow();
    expect(lines.join('')).toContain('custom prices in cli-config.json were not applied');
  });
});
