import { describe, expect, it, vi } from 'vitest';
import { createSessionProviders } from './factory';
import { SESSION_PROVIDER_IDS } from './types';

describe('createSessionProviders', () => {
  it('constructs every built-in without probing an unavailable environment', () => {
    const diagnostic = vi.fn(() => {
      throw new Error('host callback failure');
    });

    let result: ReturnType<typeof createSessionProviders> | undefined;
    expect(() => {
      result = createSessionProviders({ onDiagnostic: diagnostic });
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(result!.providers.map((provider) => provider.id)).toEqual(SESSION_PROVIDER_IDS);
    expect(result!.diagnostics).toEqual([]);
    for (const provider of result!.providers) provider.dispose();
  });
});
