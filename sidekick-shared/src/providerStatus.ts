/**
 * Stateless provider status fetcher for Claude API health.
 *
 * Calls the Atlassian Statuspage API at status.claude.com and returns
 * current status information. Polling / eventing is the caller's responsibility.
 */

export interface ProviderStatusState {
  indicator: 'none' | 'minor' | 'major' | 'critical';
  description: string;
  affectedComponents: Array<{ name: string; status: string }>;
  activeIncident: { name: string; impact: string; shortlink: string; updatedAt: string } | null;
  updatedAt: string;
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

const STATUS_URL = 'https://status.claude.com/api/v2/status.json';
const SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';

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
 * Fetch current Claude API status from status.claude.com.
 *
 * This is a **single-shot** function — it does not poll. The caller wraps
 * it in a polling loop, VS Code EventEmitter, or CLI interval as needed.
 *
 * @returns ProviderStatusState with indicator, affected components, and active incident
 */
export async function fetchProviderStatus(): Promise<ProviderStatusState> {
  try {
    const statusRes = await fetch(STATUS_URL);
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
    const summaryRes = await fetch(SUMMARY_URL);
    if (!summaryRes.ok) {
      return { indicator, description, affectedComponents: [], activeIncident: null, updatedAt };
    }

    const summaryData: SummaryResponse = await summaryRes.json();

    // Filter to non-operational components only
    const affectedComponents = (summaryData.components ?? [])
      .filter(c => c.status && c.status !== 'operational')
      .map(c => ({ name: c.name ?? 'Unknown', status: c.status ?? 'unknown' }));

    // Pick first unresolved incident
    const unresolvedIncident = (summaryData.incidents ?? [])
      .find(i => i.status !== 'resolved' && i.status !== 'postmortem');

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
