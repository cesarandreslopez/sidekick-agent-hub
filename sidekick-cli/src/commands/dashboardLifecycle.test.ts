import { describe, expect, it, vi } from 'vitest';
import type { SessionProviderBase } from 'sidekick-shared';
import { createDashboardSignalHandler, selectSessionProvider } from './dashboardLifecycle';

function provider(id: SessionProviderBase['id']): SessionProviderBase {
  return { id, dispose: vi.fn() } as unknown as SessionProviderBase;
}

describe('dashboard lifecycle', () => {
  it('reuses the selected additional provider and disposes the original', () => {
    const original = provider('claude-code');
    const codex = provider('codex');
    const create = vi.fn();
    expect(selectSessionProvider(original, [codex], 'codex', create)).toBe(codex);
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans up, unmounts Ink, and exits on a process signal', () => {
    const cleanup = vi.fn();
    const unmount = vi.fn();
    const exit = vi.fn();
    createDashboardSignalHandler(cleanup, unmount, exit)();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
