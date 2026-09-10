import type { ProviderServiceStatus, ProviderServiceSeverity } from 'sidekick-shared';

export interface ProviderStatusDisplayComponent {
  name: string;
  status: string;
}
export interface ProviderStatusDisplay {
  visible: boolean;
  providerLabel: string;
  severity: ProviderServiceSeverity | 'unavailable';
  title: string;
  summary: string;
  affectedSummary: string;
  incidentUrl?: string;
  components: ProviderStatusDisplayComponent[];
  incidents: Array<{ title: string; detail: string; url?: string }>;
  checkedAt?: string;
  providerUpdatedAt?: string | null;
}

function safeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (['http:', 'https:'].includes(url.protocol)) return url.toString();
  } catch {
    /* No link. */
  }
  return undefined;
}

/** Public vendor information, never a conclusion about this user's request. */
export function formatProviderStatusDisplay(
  providerLabel: string,
  status: ProviderServiceStatus | null | undefined,
): ProviderStatusDisplay {
  const display: ProviderStatusDisplay = {
    visible: false,
    providerLabel,
    severity: 'none',
    title: '',
    summary: '',
    affectedSummary: '',
    components: [],
    incidents: [],
  };
  if (!status) return display;
  display.checkedAt = status.checkedAt;
  if (status.availability === 'unavailable') {
    return {
      ...display,
      visible: true,
      severity: 'unavailable',
      title: `${providerLabel} public status unavailable`,
      summary: 'The public status check did not return usable evidence.',
    };
  }
  const components = status.components
    .filter((component) => component.status !== 'operational')
    .map((component) => ({ name: component.name, status: component.status.replace(/_/g, ' ') }));
  const names = new Map(status.components.map((component) => [component.id, component.name]));
  const incidents = (status.incidents ?? []).map((incident) => ({
    title: incident.title,
    detail: `${incident.status} · ${incident.impact} · Components: ${incident.componentIds === null ? 'not reported' : incident.componentIds.length === 0 ? 'none reported' : incident.componentIds.map((id) => names.get(id) ?? `${id} (unmapped)`).join(', ')} · Updated: ${incident.updatedAt ?? 'not reported'}`,
    url: safeUrl(incident.url),
  }));
  return {
    ...display,
    visible: status.severity !== 'none' || status.incidents === null || incidents.length > 0,
    severity: status.severity,
    title: `${providerLabel} public status: ${status.description}`,
    summary:
      status.incidents === null
        ? 'Incident information unavailable.'
        : (incidents[0]?.title ??
          `${components.length} component${components.length === 1 ? '' : 's'} affected`),
    affectedSummary: `${components.length} affected`,
    incidentUrl: incidents[0]?.url,
    providerUpdatedAt: status.providerUpdatedAt,
    components,
    incidents,
  };
}
