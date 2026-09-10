import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchProviderServiceStatus } = vi.hoisted(() => ({ fetchProviderServiceStatus: vi.fn() }));
vi.mock('sidekick-shared', () => ({ fetchProviderServiceStatus }));
import { ProviderStatusService } from './ProviderStatusService';
const unavailable = {
  availability: 'unavailable',
  provider: 'codex',
  reason: 'network_error',
  checkedAt: '2026-09-09T00:00:00Z',
  sourceUrl: 'https://status.openai.com/api/v2/summary.json',
};
beforeEach(() => {
  vi.useFakeTimers();
  fetchProviderServiceStatus.mockReset().mockResolvedValue(unavailable);
});
afterEach(() => vi.useRealTimers());
describe('ProviderStatusService', () => {
  it.each(['claude-code', 'codex'] as const)(
    'polls only %s and emits unavailable evidence',
    async (provider) => {
      const service = new ProviderStatusService(provider);
      const update = vi.fn();
      if (provider === 'codex') service.onOpenAIUpdate(update);
      else service.onUpdate(update);
      service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchProviderServiceStatus).toHaveBeenCalledTimes(2);
      expect(fetchProviderServiceStatus).toHaveBeenCalledWith(provider, {
        signal: expect.any(AbortSignal),
      });
      expect(update).toHaveBeenCalledWith(unavailable);
      service.stop();
    },
  );
  it('does not poll OpenCode', async () => {
    const service = new ProviderStatusService('opencode');
    service.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchProviderServiceStatus).not.toHaveBeenCalled();
    service.stop();
  });
  it('coalesces polls and ignores late results after stop', async () => {
    let finish!: (value: unknown) => void;
    fetchProviderServiceStatus.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const service = new ProviderStatusService('codex');
    const update = vi.fn();
    service.onOpenAIUpdate(update);
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchProviderServiceStatus).toHaveBeenCalledOnce();
    service.stop();
    expect(fetchProviderServiceStatus.mock.calls[0][1].signal.aborted).toBe(true);
    finish(unavailable);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(service.getCachedOpenAI()).toBeNull();
  });
});
