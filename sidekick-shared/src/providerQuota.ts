import type { PeakHoursState } from './peakHours';
import type { QuotaState } from './quota';
import type { QuotaFailureDescriptor } from './quotaPresentation';
import type { RuntimeQuotaProviderId } from './providerIds';

export { RUNTIME_QUOTA_PROVIDER_IDS } from './providerIds';
export type RuntimeQuotaProvider = RuntimeQuotaProviderId;

export interface ProviderQuotaState<
  TProvider extends RuntimeQuotaProvider = RuntimeQuotaProvider,
> extends QuotaState {
  runtimeProvider: TProvider;
  accountLabel?: string;
  accountDetail?: string;
  peakHours?: PeakHoursState | null;
  failure?: QuotaFailureDescriptor | null;
}

export interface ProviderQuotaMap {
  claude?: ProviderQuotaState<'claude'>;
  codex?: ProviderQuotaState<'codex'>;
  zai?: ProviderQuotaState<'zai'>;
}
