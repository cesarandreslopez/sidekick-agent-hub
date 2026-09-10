import { describe, expect, it, vi } from 'vitest';
const { fetchProviderServiceStatus } = vi.hoisted(() => ({ fetchProviderServiceStatus: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    event = vi.fn();
    fire = vi.fn((_value: T) => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('sidekick-shared', () => ({ fetchProviderServiceStatus }));
vi.mock('./Logger', () => ({ log: vi.fn() }));
import { ProviderStatusService } from './ProviderStatusService';
const unavailable = {
  availability: 'unavailable',
  provider: 'codex',
  reason: 'network_error',
  checkedAt: '2026-09-09T00:00:00Z',
  sourceUrl: 'https://status.openai.com/api/v2/summary.json',
};
describe('ProviderStatusService', () => {
  it('coalesces fetches and retains explicit unavailable evidence', async () => {
    let finish!: (value: unknown) => void;
    fetchProviderServiceStatus.mockReset().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const service = new ProviderStatusService();
    const first = service.fetchOpenAIStatus();
    const second = service.fetchOpenAIStatus();
    expect(first).toBe(second);
    expect(fetchProviderServiceStatus).toHaveBeenCalledOnce();
    finish(unavailable);
    await first;
    expect(service.getCachedOpenAIStatus()).toEqual(unavailable);
    service.dispose();
  });
  it('cancels outstanding requests and ignores results after disposal', async () => {
    let finish!: (value: unknown) => void;
    fetchProviderServiceStatus.mockReset().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const service = new ProviderStatusService();
    const pending = service.fetchStatus();
    service.dispose();
    expect(fetchProviderServiceStatus.mock.calls[0][1].signal.aborted).toBe(true);
    finish(unavailable);
    await pending;
    expect(service.getCachedStatus()).toBeNull();
  });
});
