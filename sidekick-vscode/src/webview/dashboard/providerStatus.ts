import type { ProviderStatusDisplay } from '../../utils/providerStatusDisplay';

/** All provider text is rendered as textContent, never markup. */
export function renderProviderStatus(
  doc: Document,
  prefix: string,
  display?: ProviderStatusDisplay,
): void {
  const section = doc.getElementById(`${prefix}-section`);
  const title = doc.getElementById(`${prefix}-title`);
  const summary = doc.getElementById(`${prefix}-summary`);
  const affected = doc.getElementById(`${prefix}-affected`);
  const toggle = doc.getElementById(`${prefix}-toggle`);
  const link = doc.getElementById(`${prefix}-link`);
  const details = doc.getElementById(`${prefix}-details`);
  if (!section || !title || !summary || !affected || !toggle || !link || !details) return;
  section.classList.remove(
    'visible',
    'status-none',
    'status-minor',
    'status-major',
    'status-critical',
    'status-maintenance',
    'status-unavailable',
  );
  if (!display?.visible) {
    details.hidden = true;
    section.removeAttribute('data-status-key');
    return;
  }
  // Check timestamps change every poll; they must not collapse an expanded report.
  const key = JSON.stringify([
    display.severity,
    display.title,
    display.summary,
    display.components,
    display.incidents,
  ]);
  const expanded = section.dataset.statusKey === key && !details.hidden;
  section.dataset.statusKey = key;
  section.classList.add('visible', `status-${display.severity}`);
  title.textContent = display.title;
  summary.textContent = display.summary;
  affected.textContent = display.affectedSummary;
  affected.style.display = display.components.length ? '' : 'none';
  if (display.incidentUrl) {
    link.setAttribute('href', display.incidentUrl);
    link.setAttribute('rel', 'noopener noreferrer');
    link.style.display = '';
  } else {
    link.removeAttribute('href');
    link.style.display = 'none';
  }
  details.replaceChildren();
  const row = (value: string) => {
    const element = doc.createElement('div');
    element.textContent = value;
    details.appendChild(element);
  };
  for (const component of display.components) row(`${component.name}: ${component.status}`);
  for (const incident of display.incidents) {
    row(incident.title);
    row(incident.detail);
    if (incident.url) {
      const anchor = doc.createElement('a');
      anchor.href = incident.url;
      anchor.textContent = 'View incident';
      anchor.rel = 'noopener noreferrer';
      anchor.target = '_blank';
      details.appendChild(anchor);
    }
  }
  row(`Checked: ${display.checkedAt ?? 'not checked'}`);
  if (display.providerUpdatedAt !== undefined)
    row(`Provider updated: ${display.providerUpdatedAt ?? 'not reported'}`);
  row(
    'Public vendor information. Incidents do not establish the cause of a request failure; component and endpoint relevance must be verified.',
  );
  details.hidden = !expanded;
  toggle.hidden = false;
  toggle.textContent = expanded ? 'Hide' : 'Details';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.onclick = () => {
    const show = details.hidden;
    details.hidden = !show;
    toggle.textContent = show ? 'Hide' : 'Details';
    toggle.setAttribute('aria-expanded', String(show));
  };
}
