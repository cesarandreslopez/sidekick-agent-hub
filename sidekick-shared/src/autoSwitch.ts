import { getActiveAccount, listAccounts, type AccountEntry, type AccountManagerResult } from './accounts';
import { switchAccount as defaultSwitchAccount } from './accountManager';
import { getActiveCodexAccount, listCodexAccounts } from './codexProfiles';
import { readQuotaSnapshot } from './quotaSnapshots';
import type { AccountProviderId, SavedAccountProfile } from './accountRegistry';
import type { ProviderQuotaMap, ProviderQuotaState } from './providerQuota';
import type { Disposable } from './quotaPoller';
import type { QuotaState } from './quota';

export interface AutoSwitchConfig {
  enabled: boolean;
  thresholdPct: number;
}

export const DEFAULT_AUTO_SWITCH_CONFIG: AutoSwitchConfig = {
  enabled: false,
  thresholdPct: 90,
};

export interface AutoSwitchCandidate {
  accountId: string;
  quota: QuotaState | null;
  switchable?: boolean;
}

export interface AutoSwitchDecision {
  switchTo: string;
}

export interface AutoSwitchActiveAccount {
  accountId: string;
  quota: QuotaState | null;
}

export interface AutoSwitchTransitionEvent {
  provider: AccountProviderId;
  from: string;
  to: string;
}

interface QuotaServiceLike {
  onUpdate(cb: (state: ProviderQuotaMap) => void): Disposable;
}

export interface AutoSwitchControllerOptions {
  quotaService: QuotaServiceLike;
  config?: AutoSwitchConfig;
  getClaudeAccounts?: () => AccountEntry[];
  getActiveClaudeAccount?: () => AccountEntry | null;
  getCodexAccounts?: () => SavedAccountProfile[];
  getActiveCodexAccount?: () => SavedAccountProfile | null;
  readSnapshot?: (providerId: AccountProviderId, accountId: string) => QuotaState | null;
  switchAccount?: (providerId: AccountProviderId, accountId: string) => AccountManagerResult;
  onTransition?: (event: AutoSwitchTransitionEvent) => void;
  log?: (message: string, error?: unknown) => void;
  cooldownMs?: number;
  now?: () => number;
}

const MATERIAL_REMAINING_IMPROVEMENT_PCT = 5;

function mergedConfig(config?: AutoSwitchConfig): AutoSwitchConfig {
  return {
    ...DEFAULT_AUTO_SWITCH_CONFIG,
    ...config,
  };
}

function quotaUtilization(quota: QuotaState | null): number {
  if (!quota?.available) return 0;
  return Math.max(quota.fiveHour.utilization, quota.sevenDay.utilization);
}

function quotaRemaining(quota: QuotaState | null): number {
  if (!quota?.available) return 0;
  return Math.max(0, 100 - quotaUtilization(quota));
}

export function decideAutoSwitch(
  _provider: AccountProviderId,
  active: AutoSwitchActiveAccount,
  candidates: AutoSwitchCandidate[],
  config?: AutoSwitchConfig,
): AutoSwitchDecision | null {
  const cfg = mergedConfig(config);
  if (!cfg.enabled) return null;
  if (!active.quota?.available) return null;

  const activeUtilization = quotaUtilization(active.quota);
  if (activeUtilization < cfg.thresholdPct) return null;

  const activeRemaining = quotaRemaining(active.quota);
  const best = candidates
    .filter(candidate =>
      candidate.accountId !== active.accountId &&
      candidate.switchable !== false &&
      candidate.quota?.available,
    )
    .sort((a, b) => quotaRemaining(b.quota) - quotaRemaining(a.quota))[0];

  if (!best) return null;
  if (quotaRemaining(best.quota) < activeRemaining + MATERIAL_REMAINING_IMPROVEMENT_PCT) return null;
  return { switchTo: best.accountId };
}

function runtimeStateToProvider(provider: 'claude' | 'codex'): AccountProviderId {
  return provider === 'claude' ? 'claude-code' : 'codex';
}

function accountIdFor(provider: AccountProviderId, account: AccountEntry | SavedAccountProfile): string {
  return provider === 'claude-code'
    ? (account as AccountEntry).uuid
    : (account as SavedAccountProfile).id;
}

export class AutoSwitchController implements Disposable {
  private readonly quotaService: QuotaServiceLike;
  private readonly getClaudeAccounts: () => AccountEntry[];
  private readonly getActiveClaudeAccount: () => AccountEntry | null;
  private readonly getCodexAccounts: () => SavedAccountProfile[];
  private readonly getActiveCodexAccount: () => SavedAccountProfile | null;
  private readonly readSnapshot: (providerId: AccountProviderId, accountId: string) => QuotaState | null;
  private readonly switchAccount: (providerId: AccountProviderId, accountId: string) => AccountManagerResult;
  private readonly onTransition?: (event: AutoSwitchTransitionEvent) => void;
  private readonly log?: (message: string, error?: unknown) => void;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private config: AutoSwitchConfig;
  private subscription: Disposable | null = null;
  private readonly switchedDuringCrossing = new Set<AccountProviderId>();
  private readonly lastSwitchAt: Partial<Record<AccountProviderId, number>> = {};

  constructor(options: AutoSwitchControllerOptions) {
    this.quotaService = options.quotaService;
    this.config = mergedConfig(options.config);
    this.getClaudeAccounts = options.getClaudeAccounts ?? listAccounts;
    this.getActiveClaudeAccount = options.getActiveClaudeAccount ?? getActiveAccount;
    this.getCodexAccounts = options.getCodexAccounts ?? listCodexAccounts;
    this.getActiveCodexAccount = options.getActiveCodexAccount ?? getActiveCodexAccount;
    this.readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
    this.switchAccount = options.switchAccount ?? defaultSwitchAccount;
    this.onTransition = options.onTransition;
    this.log = options.log;
    this.cooldownMs = options.cooldownMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.subscription) return;
    this.subscription = this.quotaService.onUpdate(state => this.handleUpdate(state));
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  dispose(): void {
    this.stop();
  }

  setConfig(config: AutoSwitchConfig): void {
    this.config = mergedConfig(config);
    if (!this.config.enabled) {
      this.switchedDuringCrossing.clear();
    }
  }

  private handleUpdate(state: ProviderQuotaMap): void {
    if (state.claude) this.handleProviderUpdate('claude', state.claude);
    if (state.codex) this.handleProviderUpdate('codex', state.codex);
  }

  private handleProviderUpdate(
    runtimeProvider: 'claude' | 'codex',
    activeQuota: ProviderQuotaState,
  ): void {
    const providerId = runtimeStateToProvider(runtimeProvider);
    const activeAccount = providerId === 'claude-code'
      ? this.getActiveClaudeAccount()
      : this.getActiveCodexAccount();
    if (!activeAccount) return;

    const activeAccountId = accountIdFor(providerId, activeAccount);
    if (quotaUtilization(activeQuota) < this.config.thresholdPct) {
      this.switchedDuringCrossing.delete(providerId);
    }

    const accounts = providerId === 'claude-code'
      ? this.getClaudeAccounts()
      : this.getCodexAccounts();
    if (accounts.length <= 1) return;

    const candidates: AutoSwitchCandidate[] = accounts.map(account => {
      const accountId = accountIdFor(providerId, account);
      return {
        accountId,
        quota: accountId === activeAccountId
          ? activeQuota
          : this.readSnapshot(providerId, accountId),
      };
    });

    const decision = decideAutoSwitch(
      providerId,
      { accountId: activeAccountId, quota: activeQuota },
      candidates,
      this.config,
    );
    if (!decision) return;
    if (this.switchedDuringCrossing.has(providerId)) return;

    const previousSwitchAt = this.lastSwitchAt[providerId] ?? 0;
    if (this.cooldownMs > 0 && this.now() - previousSwitchAt < this.cooldownMs) return;

    const result = this.switchAccount(providerId, decision.switchTo);
    if (!result.success) {
      this.log?.(`[AutoSwitch] Could not switch ${providerId} to ${decision.switchTo}.`, result.error);
      return;
    }

    this.lastSwitchAt[providerId] = this.now();
    this.switchedDuringCrossing.add(providerId);
    this.onTransition?.({
      provider: providerId,
      from: activeAccountId,
      to: decision.switchTo,
    });
  }
}
