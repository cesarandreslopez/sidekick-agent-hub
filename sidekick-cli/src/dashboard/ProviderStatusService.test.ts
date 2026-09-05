import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProviderStatus, fetchOpenAIStatus } = vi.hoisted(() => ({
  fetchProviderStatus: vi.fn(),
  fetchOpenAIStatus: vi.fn(),
}));

vi.mock('sidekick-shared', () => ({ fetchProviderStatus, fetchOpenAIStatus }));

import { ProviderStatusService } from './ProviderStatusService';

describe('ProviderStatusService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchProviderStatus.mockReset().mockResolvedValue({ status: 'operational', source: 'claude' });
    fetchOpenAIStatus.mockReset().mockResolvedValue({ status: 'operational', source: 'openai' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls only the Claude status page for claude-code', async () => {
    const service = new ProviderStatusService('claude-code');
    const updates: unknown[] = [];
    service.onUpdate((status) => updates.push(status));
    service.onOpenAIUpdate(() => updates.push('openai'));

    service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchProviderStatus).toHaveBeenCalledTimes(2);
    expect(fetchOpenAIStatus).not.toHaveBeenCalled();
    expect(updates).toHaveLength(2);
    expect(service.getCachedOpenAI()).toBeNull();
    service.stop();
  });

  it('polls only the OpenAI status page for codex', async () => {
    const service = new ProviderStatusService('codex');
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchOpenAIStatus).toHaveBeenCalledTimes(2);
    expect(fetchProviderStatus).not.toHaveBeenCalled();
    expect(service.getCached()).toBeNull();
    expect(service.getCachedOpenAI()).toEqual({ status: 'operational', source: 'openai' });
    service.stop();
  });

  it('polls nothing for opencode', async () => {
    const service = new ProviderStatusService('opencode');
    expect(service.pollsAnything).toBe(false);
    service.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchProviderStatus).not.toHaveBeenCalled();
    expect(fetchOpenAIStatus).not.toHaveBeenCalled();
    service.stop();
  });
});
