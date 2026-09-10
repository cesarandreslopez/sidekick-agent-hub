import type { AccountProviderId } from './providerIds';

export type ProviderServiceSeverity = 'none' | 'minor' | 'major' | 'critical' | 'maintenance';

export interface ProviderServiceComponent {
  id: string;
  name: string;
  status: string;
}

export interface ProviderServiceIncident {
  id: string;
  title: string;
  status: string;
  impact: string;
  url: string | null;
  updatedAt: string | null;
  /** null means associations were not supplied; [] means explicitly no associations. */
  componentIds: string[] | null;
}

export type ProviderServiceStatusFailureReason =
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response';

interface ProviderServiceObservation {
  provider: AccountProviderId;
  /** Completion time of this check, independent of the provider's update time. */
  checkedAt: string;
  sourceUrl: string;
}

export interface ObservedProviderServiceStatus extends ProviderServiceObservation {
  availability: 'observed';
  severity: ProviderServiceSeverity;
  description: string;
  providerUpdatedAt: string | null;
  components: ProviderServiceComponent[];
  /** null means the feed omitted incident evidence, not that there are no incidents. */
  incidents: ProviderServiceIncident[] | null;
}

export interface UnavailableProviderServiceStatus extends ProviderServiceObservation {
  availability: 'unavailable';
  reason: ProviderServiceStatusFailureReason;
  httpStatus?: number;
}

export type ProviderServiceStatus =
  | ObservedProviderServiceStatus
  | UnavailableProviderServiceStatus;

export interface FetchProviderServiceStatusOptions {
  signal?: AbortSignal;
}
