import type { ProviderServiceStatus } from 'sidekick-shared';

/** Product copy for public vendor observations, independent of request readiness. */
export function presentProviderStatus(status: ProviderServiceStatus): {
  label: string;
  color: 'gray' | 'green' | 'yellow' | 'red';
  visible: boolean;
  summary: string;
  lines: string[];
} {
  const vendor = status.provider === 'codex' ? 'OpenAI' : 'Claude';
  const label = `${vendor} public service status`;
  if (status.availability === 'unavailable') {
    return {
      label,
      color: 'gray',
      visible: true,
      summary: `${vendor} status unavailable`,
      lines: ['Status unavailable', `Checked: ${status.checkedAt}`, `Source: ${status.sourceUrl}`],
    };
  }
  const partial = status.incidents === null;
  const names = new Map(status.components.map((component) => [component.id, component.name]));
  const lines = [
    status.description,
    `Checked: ${status.checkedAt}`,
    `Provider updated: ${status.providerUpdatedAt ?? 'not reported'}`,
  ];
  for (const component of status.components.filter(
    (component) => component.status !== 'operational',
  ))
    lines.push(`${component.name}: ${component.status.replace(/_/g, ' ')}`);
  if (partial) lines.push('Incident information unavailable.');
  for (const incident of status.incidents ?? []) {
    lines.push(`${incident.title} (${incident.status}, ${incident.impact})`);
    lines.push(
      `Components: ${incident.componentIds === null ? 'not reported' : incident.componentIds.length === 0 ? 'none reported' : incident.componentIds.map((id) => names.get(id) ?? `${id} (unmapped)`).join(', ')}`,
    );
    lines.push(`Incident updated: ${incident.updatedAt ?? 'not reported'}`);
    if (incident.url) lines.push(incident.url);
  }
  lines.push(
    'Public vendor information; incidents do not establish the cause of a request failure.',
  );
  return {
    label,
    lines,
    visible: status.severity !== 'none' || partial || !!status.incidents?.length,
    color:
      status.severity === 'none'
        ? partial
          ? 'gray'
          : 'green'
        : ['minor', 'maintenance'].includes(status.severity)
          ? 'yellow'
          : 'red',
    summary: `${vendor} public status: ${partial && status.severity === 'none' ? 'partial evidence' : status.severity}`,
  };
}
