export interface HandoffUrlIdentifiers {
  sessionId: string;
  provider: string;
  projectPath: string;
}

const ALLOWED_PLACEHOLDERS = new Set(['sessionId', 'provider', 'projectPath']);

/** Renders an external handoff URL using identifiers only. */
export function renderHandoffUrlTemplate(
  template: string,
  identifiers: HandoffUrlIdentifiers,
): string {
  if (!template.trim()) throw new Error('No handoff URL template is configured.');
  const rendered = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      throw new Error(`Unsupported handoff URL placeholder: {${name}}`);
    }
    return encodeURIComponent(identifiers[name as keyof HandoffUrlIdentifiers]);
  });
  let url: URL;
  try {
    url = new URL(rendered);
  } catch {
    throw new Error('The rendered handoff URL is invalid.');
  }
  if (['javascript:', 'data:', 'file:'].includes(url.protocol)) {
    throw new Error(`Unsafe handoff URL protocol: ${url.protocol}`);
  }
  return url.toString();
}
