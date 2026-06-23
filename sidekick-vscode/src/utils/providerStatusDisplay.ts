import type { ProviderStatusState } from 'sidekick-shared';

export interface ProviderStatusDisplayComponent {
  name: string;
  status: string;
}

export interface ProviderStatusDisplay {
  visible: boolean;
  providerLabel: string;
  severity: ProviderStatusState['indicator'];
  title: string;
  summary: string;
  affectedSummary: string;
  incidentUrl?: string;
  components: ProviderStatusDisplayComponent[];
}

export function formatProviderStatusDisplay(
  providerLabel: string,
  status: ProviderStatusState | null | undefined,
): ProviderStatusDisplay {
  const hidden = createHiddenDisplay(providerLabel);
  if (!status || status.indicator === 'none') return hidden;

  const description = status.description || status.indicator.charAt(0).toUpperCase() + status.indicator.slice(1);
  const components = (status.affectedComponents ?? []).map(component => ({
    name: component.name || 'Unknown',
    status: formatComponentStatus(component.status),
  }));
  const componentCount = components.length;

  return {
    visible: true,
    providerLabel,
    severity: status.indicator,
    title: `${providerLabel}: ${description}`,
    summary: status.activeIncident?.name || formatComponentSummary(componentCount),
    affectedSummary: componentCount === 1 ? '1 affected' : `${componentCount} affected`,
    incidentUrl: normalizeIncidentUrl(status.activeIncident?.shortlink),
    components,
  };
}

function createHiddenDisplay(providerLabel: string): ProviderStatusDisplay {
  return {
    visible: false,
    providerLabel,
    severity: 'none',
    title: '',
    summary: '',
    affectedSummary: '',
    components: [],
  };
}

function formatComponentStatus(status: string): string {
  return (status || 'unknown').replace(/_/g, ' ');
}

function formatComponentSummary(componentCount: number): string {
  if (componentCount === 1) return '1 component affected';
  if (componentCount > 1) return `${componentCount} components affected`;
  return 'Status details unavailable';
}

function normalizeIncidentUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}
