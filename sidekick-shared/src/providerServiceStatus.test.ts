import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderServiceStatus } from './providerServiceStatus';
import { ACCOUNT_PROVIDER_IDS } from './providerIds';

const checkedAt = '2026-09-09T12:00:00.000Z';
const updatedAt = '2026-09-01T08:00:00Z';
const component = { id: 'component-a', name: 'API', status: 'operational' };
const incident = {
  id: 'incident-a',
  name: 'Errors',
  status: 'investigating',
  impact: 'major',
  shortlink: 'https://stspg.io/test',
  updated_at: updatedAt,
  components: [component],
};
function summary() {
  return {
    page: { updated_at: updatedAt },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [component],
    incidents: [] as unknown[],
  };
}
function response(body: unknown) {
  return { ok: true, json: async () => body };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(ACCOUNT_PROVIDER_IDS)('fetchProviderServiceStatus: %s', (provider) => {
  it('observes operational status with components and independent timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const fetch = vi.fn().mockResolvedValue(response(summary()));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({
      availability: 'observed',
      provider,
      checkedAt,
      severity: 'none',
      providerUpdatedAt: updatedAt,
      components: [component],
      incidents: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `https://status.${provider === 'codex' ? 'openai' : 'claude'}.com/api/v2/summary.json`,
      { signal: expect.any(AbortSignal), credentials: 'omit' },
    );
  });

  it('preserves multiple incidents and component associations, excluding resolved incidents', async () => {
    const body = summary();
    body.status = { indicator: 'major', description: 'Major outage' };
    body.incidents = [
      incident,
      { ...incident, id: 'incident-b', components: ['unmapped-id'] },
      { ...incident, id: 'resolved', status: 'resolved' },
      { ...incident, id: 'postmortem', status: 'postmortem' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({
      availability: 'observed',
      severity: 'major',
      incidents: [
        {
          id: 'incident-a',
          title: 'Errors',
          status: 'investigating',
          impact: 'major',
          url: incident.shortlink,
          updatedAt,
          componentIds: ['component-a'],
        },
        { id: 'incident-b', componentIds: ['unmapped-id'] },
      ],
    });
  });

  it('represents omitted incidents and update timestamps without inventing evidence', async () => {
    const body = { ...summary(), incidents: undefined, page: {} };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    expect(await fetchProviderServiceStatus(provider)).toMatchObject({
      availability: 'observed',
      incidents: null,
      providerUpdatedAt: null,
    });
  });

  it('preserves unknown component associations', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ ...summary(), incidents: [{ ...incident, components: undefined }] }),
        ),
    );
    expect(await fetchProviderServiceStatus(provider)).toMatchObject({
      availability: 'observed',
      incidents: [{ componentIds: null }],
    });
  });

  it.each([
    null,
    {},
    { ...summary(), status: {} },
    { ...summary(), status: { indicator: 'surprise', description: 'unknown' } },
    { ...summary(), components: [{}] },
    { ...summary(), incidents: {} },
    { ...summary(), incidents: [null] },
    { ...summary(), page: { updated_at: 'not a date' } },
    { ...summary(), incidents: [{ ...incident, shortlink: 'javascript:alert(1)' }] },
  ])('rejects malformed supplied data: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({ availability: 'unavailable', reason: 'invalid_response' });
    expect(result).not.toHaveProperty('severity');
  });

  it('rejects malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('invalid JSON');
        },
      }),
    );
    expect(await fetchProviderServiceStatus(provider)).toMatchObject({
      availability: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('distinguishes a body connection failure from malformed data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new TypeError('connection terminated');
        },
      }),
    );
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({ availability: 'unavailable', reason: 'network_error' });
    expect(result).not.toHaveProperty('severity');
  });

  it('reports a failed request without error text or operational severity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret connection detail')));
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({ availability: 'unavailable', reason: 'network_error' });
    expect(result).not.toHaveProperty('severity');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([403, 429, 503])('reports HTTP %s as missing status evidence', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    const result = await fetchProviderServiceStatus(provider);
    expect(result).toMatchObject({
      availability: 'unavailable',
      reason: 'http_error',
      httpStatus: status,
    });
    expect(result).not.toHaveProperty('severity');
  });

  it.each(['headers', 'body'])('times out hung %s after ten seconds', async (phase) => {
    vi.useFakeTimers();
    const hung = new Promise(() => {});
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        phase === 'headers' ? hung : Promise.resolve({ ok: true, json: () => hung }),
      );
    vi.stubGlobal('fetch', fetch);
    const pending = fetchProviderServiceStatus(provider);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ availability: 'unavailable', reason: 'timeout' });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    'handles caller cancellation (already aborted: %s)',
    async (preAborted) => {
      const controller = new AbortController();
      const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
      vi.stubGlobal('fetch', fetch);
      if (preAborted) controller.abort();
      const pending = fetchProviderServiceStatus(provider, { signal: controller.signal });
      controller.abort();
      expect(await pending).toMatchObject({ availability: 'unavailable', reason: 'cancelled' });
      expect(fetch).toHaveBeenCalledTimes(preAborted ? 0 : 1);
    },
  );

  it('is stateless and cleans up cancellation listeners', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetch = vi.fn().mockResolvedValue(response(summary()));
    vi.stubGlobal('fetch', fetch);
    await fetchProviderServiceStatus(provider, { signal: controller.signal });
    await fetchProviderServiceStatus(provider);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
