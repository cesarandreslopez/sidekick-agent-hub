/**
 * Stateless provider status fetchers for Atlassian Statuspage APIs.
 *
 * Supports both status.claude.com and status.openai.com (same API format).
 * Polling / eventing is the caller's responsibility.
 */

/** Legacy projection. Use ProviderServiceStatus for explicit availability evidence. */
export interface ProviderStatusState {
  indicator: 'none' | 'minor' | 'major' | 'critical';
  description: string;
  affectedComponents: Array<{ name: string; status: string }>;
  activeIncident: { name: string; impact: string; shortlink: string; updatedAt: string } | null;
  updatedAt: string;
}

/** Compatibility projection only; it cannot express evidence availability. */
export function toLegacyProviderStatus(
  status: import('./providerServiceStatusTypes').ProviderServiceStatus,
): ProviderStatusState {
  if (status.availability === 'unavailable') {
    return {
      indicator: 'none',
      description: 'Status unavailable',
      affectedComponents: [],
      activeIncident: null,
      updatedAt: status.checkedAt,
    };
  }
  const incident = status.incidents?.[0];
  return {
    indicator: status.severity === 'maintenance' ? 'minor' : status.severity,
    description: status.description,
    affectedComponents: status.components
      .filter((component) => component.status !== 'operational')
      .map(({ name, status }) => ({ name, status })),
    activeIncident: incident
      ? {
          name: incident.title,
          impact: incident.impact,
          shortlink: incident.url ?? '',
          updatedAt: incident.updatedAt ?? '',
        }
      : null,
    updatedAt: status.providerUpdatedAt ?? '',
  };
}

interface StatusResponse {
  status?: { indicator?: string; description?: string };
  page?: { updated_at?: string };
}

interface SummaryComponent {
  name?: string;
  status?: string;
}

interface SummaryIncident {
  name?: string;
  impact?: string;
  shortlink?: string;
  updated_at?: string;
  status?: string;
}

interface SummaryResponse {
  components?: SummaryComponent[];
  incidents?: SummaryIncident[];
}

const CLAUDE_BASE = 'https://status.claude.com';
const OPENAI_BASE = 'https://status.openai.com';

function fallbackState(): ProviderStatusState {
  return {
    indicator: 'none',
    description: 'Status unavailable',
    affectedComponents: [],
    activeIncident: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Generic fetcher for any Atlassian Statuspage-compatible endpoint.
 */
async function fetchStatusPage(baseUrl: string): Promise<ProviderStatusState> {
  try {
    const statusRes = await fetchWithTimeout(`${baseUrl}/api/v2/status.json`);
    if (!statusRes.ok) return fallbackState();

    const statusData: StatusResponse = await statusRes.json();
    const indicator = (statusData.status?.indicator ?? 'none') as ProviderStatusState['indicator'];
    const description = statusData.status?.description ?? '';
    const updatedAt = statusData.page?.updated_at ?? new Date().toISOString();

    // All operational — no need to fetch summary
    if (indicator === 'none') {
      return { indicator, description, affectedComponents: [], activeIncident: null, updatedAt };
    }

    // Degraded — fetch summary for components + incidents
    const summaryRes = await fetchWithTimeout(`${baseUrl}/api/v2/summary.json`);
    if (!summaryRes.ok) {
      return { indicator, description, affectedComponents: [], activeIncident: null, updatedAt };
    }

    const summaryData: SummaryResponse = await summaryRes.json();

    // Filter to non-operational components only
    const affectedComponents = (summaryData.components ?? [])
      .filter((c) => c.status && c.status !== 'operational')
      .map((c) => ({ name: c.name ?? 'Unknown', status: c.status ?? 'unknown' }));

    // Pick first unresolved incident
    const unresolvedIncident = (summaryData.incidents ?? []).find(
      (i) => i.status !== 'resolved' && i.status !== 'postmortem',
    );

    const activeIncident = unresolvedIncident
      ? {
          name: unresolvedIncident.name ?? 'Unknown incident',
          impact: unresolvedIncident.impact ?? 'unknown',
          shortlink: unresolvedIncident.shortlink ?? '',
          updatedAt: unresolvedIncident.updated_at ?? updatedAt,
        }
      : null;

    return { indicator, description, affectedComponents, activeIncident, updatedAt };
  } catch {
    return fallbackState();
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref();
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch current Claude API status from status.claude.com.
 *
 * Single-shot — caller wraps in polling loop, EventEmitter, or interval.
 * Consumers requiring reliable availability semantics should use fetchProviderServiceStatus.
 */
export async function fetchProviderStatus(): Promise<ProviderStatusState> {
  return fetchStatusPage(CLAUDE_BASE);
}

/**
 * Fetch current OpenAI API status from status.openai.com.
 *
 * Single-shot — caller wraps in polling loop, EventEmitter, or interval.
 * Consumers requiring reliable availability semantics should use fetchProviderServiceStatus.
 */
export async function fetchOpenAIStatus(): Promise<ProviderStatusState> {
  return fetchStatusPage(OPENAI_BASE);
}
