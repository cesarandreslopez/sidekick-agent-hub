import type { PeakHoursState } from './peakHours';
import type { QuotaState } from './quota';
import type { QuotaFailureDescriptor } from './quotaPresentation';

export type RuntimeQuotaProvider = 'claude' | 'codex';

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
}
