import { describe, expect, it, vi } from 'vitest';

const mockFetchProviderStatus = vi.hoisted(() => vi.fn());
const mockFetchOpenAIStatus = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    event = vi.fn();
    fire = vi.fn((_value: T) => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('sidekick-shared', () => ({
  fetchProviderStatus: (...args: unknown[]) => mockFetchProviderStatus(...args),
  fetchOpenAIStatus: (...args: unknown[]) => mockFetchOpenAIStatus(...args),
}));
vi.mock('./Logger', () => ({ log: vi.fn() }));

import { ProviderStatusService } from './ProviderStatusService';

describe('ProviderStatusService', () => {
  it('does not overlap status-page poll cycles', async () => {
    let resolve!: (value: unknown) => void;
    const deferred = new Promise((done) => {
      resolve = done;
    });
    mockFetchProviderStatus.mockReturnValue(deferred);
    mockFetchOpenAIStatus.mockReturnValue(deferred);
    const service = new ProviderStatusService();
    const fetchAll = (service as never as { fetchAll(): Promise<void> }).fetchAll.bind(service);

    const first = fetchAll();
    const overlapping = fetchAll();

    expect(mockFetchProviderStatus).toHaveBeenCalledOnce();
    expect(mockFetchOpenAIStatus).toHaveBeenCalledOnce();
    await expect(overlapping).resolves.toBeUndefined();

    resolve({
      indicator: 'none',
      description: 'ok',
      affectedComponents: [],
      activeIncident: null,
      updatedAt: '2026-07-21T00:00:00Z',
    });
    await first;
    service.dispose();
  });
});
