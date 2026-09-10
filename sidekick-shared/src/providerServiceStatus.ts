import type { AccountProviderId } from './providerIds';
import type {
  FetchProviderServiceStatusOptions,
  ObservedProviderServiceStatus,
  ProviderServiceIncident,
  ProviderServiceSeverity,
  ProviderServiceStatus,
  ProviderServiceStatusFailureReason,
} from './providerServiceStatusTypes';

const SOURCES: Record<AccountProviderId, string> = {
  'claude-code': 'https://status.claude.com/api/v2/summary.json',
  codex: 'https://status.openai.com/api/v2/summary.json',
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid string');
  return value;
}

function date(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(Date.parse(raw)))
    throw new Error('Invalid date');
  return raw;
}

function url(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = string(value);
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid link');
  return raw;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid array');
  return value;
}

function parseSummary(
  raw: unknown,
): Omit<ObservedProviderServiceStatus, 'provider' | 'sourceUrl' | 'checkedAt'> {
  const data = object(raw);
  const status = object(data.status);
  const severity = string(status.indicator);
  if (!['none', 'minor', 'major', 'critical', 'maintenance'].includes(severity))
    throw new Error('Invalid severity');
  const components = array(data.components).map((rawComponent) => {
    const component = object(rawComponent);
    return {
      id: string(component.id),
      name: string(component.name),
      status: string(component.status),
    };
  });
  const incidents: ProviderServiceIncident[] | null =
    data.incidents === undefined
      ? null
      : array(data.incidents)
          .map((rawIncident) => {
            const incident = object(rawIncident);
            // Statuspage uses objects; its compatible feeds may supply component IDs directly.
            const associations = incident.components ?? incident.component_ids;
            return {
              id: string(incident.id),
              title: string(incident.name),
              status: string(incident.status),
              impact: string(incident.impact),
              url: url(incident.shortlink ?? incident.url),
              updatedAt: date(incident.updated_at),
              componentIds:
                associations === undefined
                  ? null
                  : array(associations).map((component) =>
                      typeof component === 'string'
                        ? string(component)
                        : string(object(component).id),
                    ),
            };
          })
          .filter(
            (incident) => !['resolved', 'postmortem'].includes(incident.status.toLowerCase()),
          );
  return {
    availability: 'observed',
    severity: severity as ProviderServiceSeverity,
    description: string(status.description),
    providerUpdatedAt: date(object(data.page).updated_at),
    components,
    incidents,
  };
}

/**
 * Fetch public vendor status without credentials, caching, polling, or retries.
 * Incidents supplement a request diagnosis; they do not prove its cause. Consumers
 * own freshness and component/endpoint correlation. Omitted incidents are null.
 */
export async function fetchProviderServiceStatus(
  provider: AccountProviderId,
  { signal }: FetchProviderServiceStatusOptions = {},
): Promise<ProviderServiceStatus> {
  const sourceUrl = SOURCES[provider];
  const observation = () => ({ provider, sourceUrl, checkedAt: new Date().toISOString() });
  const unavailable = (
    reason: ProviderServiceStatusFailureReason,
    httpStatus?: number,
  ): ProviderServiceStatus => ({
    ...observation(),
    availability: 'unavailable',
    reason,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  });
  if (signal?.aborted) return unavailable('cancelled');

  const controller = new AbortController();
  let aborted: 'timeout' | 'cancelled' | undefined;
  let rejectAbort: (reason: Error) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: 'timeout' | 'cancelled') => {
    if (aborted) return;
    aborted = reason;
    controller.abort();
    rejectAbort(new Error(reason));
  };
  const onCancel = () => abort('cancelled');
  signal?.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), 10_000);
  timer.unref?.();
  try {
    return await Promise.race([
      abortPromise,
      (async (): Promise<ProviderServiceStatus> => {
        const response = await fetch(sourceUrl, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) return unavailable('http_error', response.status);
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          return unavailable(
            aborted ?? (error instanceof SyntaxError ? 'invalid_response' : 'network_error'),
          );
        }
        try {
          return { ...observation(), ...parseSummary(body) };
        } catch {
          return unavailable('invalid_response');
        }
      })(),
    ]);
  } catch {
    return unavailable(aborted ?? 'network_error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}
