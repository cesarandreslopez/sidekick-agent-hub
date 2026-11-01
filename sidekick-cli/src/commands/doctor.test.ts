import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunDoctor } = vi.hoisted(() => ({ mockRunDoctor: vi.fn() }));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  runDoctor: (...args: unknown[]) => mockRunDoctor(...args),
}));

import { doctorAction, withPricingCheck } from './doctor';
import { _resetPricingBasisForTests } from '../pricingBasis';

function report(status: 'healthy' | 'attention' | 'unhealthy' = 'healthy') {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    project: { resolvedCwd: '/work' },
    status,
    checks: [{ id: 'accounts', status: 'ok', title: 'Accounts', message: 'fine' }],
  } as never;
}

describe('withPricingCheck', () => {
  const check = (status: 'ok' | 'warning') => ({
    id: 'pricing_catalog' as const,
    status,
    title: 'Pricing catalog',
    message: 'LiteLLM catalog, fetched 2h ago',
  });

  it('appends the check and lifts a healthy report to attention on a warning', () => {
    const ok = withPricingCheck(report(), check('ok'));
    expect(ok.status).toBe('healthy');
    expect(ok.checks.map((entry) => entry.id)).toEqual(['accounts', 'pricing_catalog']);
    expect(withPricingCheck(report(), check('warning')).status).toBe('attention');
    expect(withPricingCheck(report('unhealthy'), check('warning')).status).toBe('unhealthy');
  });
});

describe('doctorAction', () => {
  let stdout = '';

  beforeEach(() => {
    stdout = '';
    _resetPricingBasisForTests();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    mockRunDoctor.mockReset();
    mockRunDoctor.mockResolvedValue(report());
  });

  afterEach(() => vi.restoreAllMocks());

  const makeCmd = (json: boolean) =>
    ({ parent: { opts: () => ({ json }) } }) as unknown as import('commander').Command;

  it('prints a pricing line in the text report', async () => {
    await doctorAction({}, makeCmd(false));
    // No hydration ran in this test, so only the built-in table is active.
    expect(stdout).toContain(
      '! Pricing catalog: built-in static prices only (catalog not loaded for this command)',
    );
    expect(stdout).toMatch(/digest fnv1a64:[0-9a-f]{16}/);
    expect(stdout).toContain('Repair: Run sidekick once with network access');
    expect(stdout).toContain('Sidekick Doctor — attention');
  });

  it('adds the check and a pricingCatalog key to --json', async () => {
    await doctorAction({}, makeCmd(true));
    const parsed = JSON.parse(stdout);
    expect(parsed.checks.at(-1)).toMatchObject({ id: 'pricing_catalog', status: 'warning' });
    expect(parsed.pricingCatalog).toMatchObject({ source: 'static', registeredEntries: 0 });
  });
});
