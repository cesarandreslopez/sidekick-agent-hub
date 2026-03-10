import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchProviderStatus } from './providerStatus';

describe('fetchProviderStatus', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns clean state when all operational (only hits status.json)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: { indicator: 'none', description: 'All Systems Operational' },
        page: { updated_at: '2026-03-10T12:00:00Z' },
      }),
    });

    const result = await fetchProviderStatus();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://status.claude.com/api/v2/status.json');
    expect(result).toEqual({
      indicator: 'none',
      description: 'All Systems Operational',
      affectedComponents: [],
      activeIncident: null,
      updatedAt: '2026-03-10T12:00:00Z',
    });
  });

  it('returns filtered components and incident when degraded', async () => {
    // First call: status.json
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: { indicator: 'major', description: 'Major System Outage' },
        page: { updated_at: '2026-03-10T14:00:00Z' },
      }),
    });

    // Second call: summary.json
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { name: 'API', status: 'major_outage' },
          { name: 'Dashboard', status: 'operational' },
          { name: 'Console', status: 'degraded_performance' },
        ],
        incidents: [
          {
            name: 'API Degradation',
            impact: 'major',
            shortlink: 'https://stspg.io/abc123',
            updated_at: '2026-03-10T13:30:00Z',
            status: 'investigating',
          },
          {
            name: 'Old Incident',
            impact: 'minor',
            shortlink: 'https://stspg.io/old',
            updated_at: '2026-03-09T10:00:00Z',
            status: 'resolved',
          },
        ],
      }),
    });

    const result = await fetchProviderStatus();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://status.claude.com/api/v2/status.json');
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://status.claude.com/api/v2/summary.json');
    expect(result).toEqual({
      indicator: 'major',
      description: 'Major System Outage',
      affectedComponents: [
        { name: 'API', status: 'major_outage' },
        { name: 'Console', status: 'degraded_performance' },
      ],
      activeIncident: {
        name: 'API Degradation',
        impact: 'major',
        shortlink: 'https://stspg.io/abc123',
        updatedAt: '2026-03-10T13:30:00Z',
      },
      updatedAt: '2026-03-10T14:00:00Z',
    });
  });

  it('returns graceful fallback on fetch failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchProviderStatus();

    expect(result.indicator).toBe('none');
    expect(result.description).toBe('Status unavailable');
    expect(result.affectedComponents).toEqual([]);
    expect(result.activeIncident).toBeNull();
    expect(result.updatedAt).toBeTruthy();
  });

  it('returns graceful fallback when status.json returns non-ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await fetchProviderStatus();

    expect(result.indicator).toBe('none');
    expect(result.description).toBe('Status unavailable');
  });

  it('handles summary.json failure gracefully when degraded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: { indicator: 'minor', description: 'Minor issue' },
        page: { updated_at: '2026-03-10T15:00:00Z' },
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await fetchProviderStatus();

    expect(result.indicator).toBe('minor');
    expect(result.description).toBe('Minor issue');
    expect(result.affectedComponents).toEqual([]);
    expect(result.activeIncident).toBeNull();
  });
});
