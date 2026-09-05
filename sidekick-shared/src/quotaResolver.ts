/**
 * One quota resolution path for every Sidekick surface.
 *
 * `sidekick quota`, `quota --all`, the MCP facts server, and both dashboards
 * used to pick between the live API, session logs, and the persisted snapshot
 * in four different orders. `resolveQuota()` applies one precedence:
 *
 * 1. a fresh persisted snapshot (younger than `QUOTA_FRESH_MAX_AGE_MS`, whatever
 *    its origin: the official status-line sample, a session log, or an earlier
 *    API call) — zero network;
 * 2. a session-derived sample (Codex rollouts carry rate limits; Claude and
 *    z.ai have no local equivalent);
 * 3. the provider API, when `allowApi` is not disabled;
 * 4. an aging or stale snapshot, labelled as such, with the API failure attached;
 * 5. an unavailable state describing why nothing could be resolved.
 *
 * `preferFresh: false` skips step 1 (the `--refresh` flag). Every result carries
 * `source`, `capturedSource`, `freshness`, `ageMs`, and a `resolution` tag.
 */

import { resolveActiveClaudeAccount } from './accounts';
import type { ResolvedActiveAccount, SavedAccountProfile } from './accountRegistry';
import { getActiveCodexAccount, resolveActiveCodexAccount } from './codexProfiles';
import {
  enrichCodexQuota,
  fetchCodexQuotaFromApi,
  resolveCodexQuotaFromLocalSources,
} from './codexQuota';
import { readClaudeMaxCredentials } from './credentials';
import type { ProviderQuotaState } from './providerQuota';
import type { CodexProvider } from './providers/codex';
import { classifyQuotaFreshness, fetchQuota, withQuotaProjections } from './quota';
import type { QuotaState } from './quota';
import { describeQuotaFailure } from './quotaPresentation';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { QuotaSnapshotProviderId } from './quotaSnapshots';
import { enrichZaiQuota, fetchZaiQuotaFromApi } from './zaiQuotaApi';
import type { ZaiQuotaApiOptions } from './zaiQuotaApi';

/** Providers the resolver knows how to read. `opencode` callers map to `zai`. */
export type QuotaResolveProviderId = 'claude-code' | 'codex' | 'zai';

/** Which step of the precedence produced the answer. */
export type QuotaResolution =
  | 'snapshot-fresh'
  | 'session'
  | 'api'
  | 'snapshot-aging'
  | 'snapshot-stale'
  | 'unavailable';

type RuntimeProviderFor<T extends QuotaResolveProviderId> = T extends 'claude-code'
  ? 'claude'
  : T extends 'codex'
    ? 'codex'
    : 'zai';

export interface ResolvedQuota<
  T extends QuotaResolveProviderId = QuotaResolveProviderId,
> extends ProviderQuotaState<RuntimeProviderFor<T>> {
  /** Precedence step that produced this sample. */
  resolution: QuotaResolution;
}

export interface ResolveQuotaOptions<T extends QuotaResolveProviderId = QuotaResolveProviderId> {
  providerId: T;
  /** Snapshot key; derived from the active account when omitted. */
  accountId?: string;
  /** Workspace whose Codex rollouts are searched first for session-derived rate limits. */
  workspacePath?: string;
  /** Use a fresh persisted snapshot before anything else (default true). `--refresh` passes false. */
  preferFresh?: boolean;
  /** Allow a provider API call when no fresh local sample exists (default true). */
  allowApi?: boolean;
  /** Re-point a stale saved-account pointer while resolving the account (default true). */
  selfHeal?: boolean;
  /** Clock for freshness classification; defaults to `new Date()`. */
  now?: Date;
  /** Fetch implementation forwarded to every API call (tests inject a stub). */
  fetchImpl?: typeof fetch;
  readSnapshot?: (
    providerId: QuotaSnapshotProviderId,
    accountId: string,
    now?: Date,
  ) => QuotaState | null;
  writeSnapshot?: (
    providerId: QuotaSnapshotProviderId,
    accountId: string,
    quota: QuotaState,
  ) => void;
  /** Claude access token source; defaults to `readClaudeMaxCredentials()`. */
  getClaudeAccessToken?: () => Promise<string | null>;
  /** Claude account resolution; defaults to `resolveActiveClaudeAccount()`. */
  resolveClaudeAccount?: (options: { selfHeal?: boolean }) => ResolvedActiveAccount;
  /** Codex account resolution; defaults to the self-healing registry lookup. */
  resolveCodexAccount?: (options: { selfHeal?: boolean }) => SavedAccountProfile | null;
  /** Reuse a caller-owned Codex provider for the session scan. */
  codexProvider?: CodexProvider;
  /** Codex home whose `auth.json` and rollouts are read. */
  codexHome?: string;
  /** Explicit Codex access token for the API step. */
  codexAccessToken?: string;
  /** z.ai credential discovery and API options. */
  zai?: ZaiQuotaApiOptions;
}

const ZAI_DEFAULT_ACCOUNT_ID = 'default';
const CLAUDE_NO_CREDENTIALS_ERROR = 'No OAuth token available';

interface ResolvedIdentity {
  accountId: string | undefined;
  codexAccount: SavedAccountProfile | null;
  accountLabel?: string;
  accountDetail?: string;
}

function snapshotProviderId(providerId: QuotaResolveProviderId): QuotaSnapshotProviderId {
  return providerId;
}

function defaultResolveCodexAccount(options: { selfHeal?: boolean }): SavedAccountProfile | null {
  // Self-heal the saved pointer to the live login first so the snapshot key and
  // the display identity both track reality after a native `codex login`.
  resolveActiveCodexAccount(options);
  return getActiveCodexAccount();
}

function resolveIdentity(options: ResolveQuotaOptions): ResolvedIdentity {
  const selfHeal = options.selfHeal ?? true;
  switch (options.providerId) {
    case 'claude-code': {
      const account = (options.resolveClaudeAccount ?? resolveActiveClaudeAccount)({ selfHeal });
      return {
        accountId: options.accountId ?? account.registryAccountId,
        codexAccount: null,
        accountLabel: account.label ?? account.email,
        accountDetail: account.email,
      };
    }
    case 'codex': {
      const profile = (options.resolveCodexAccount ?? defaultResolveCodexAccount)({ selfHeal });
      return {
        accountId: options.accountId ?? profile?.id,
        codexAccount: profile,
        accountLabel: profile?.label,
        accountDetail: profile?.email,
      };
    }
    case 'zai':
      return { accountId: options.accountId ?? ZAI_DEFAULT_ACCOUNT_ID, codexAccount: null };
  }
}

async function defaultClaudeAccessToken(): Promise<string | null> {
  const credentials = await readClaudeMaxCredentials();
  return credentials?.accessToken ?? null;
}

function zeroWindows(): Pick<QuotaState, 'fiveHour' | 'sevenDay'> {
  return { fiveHour: { utilization: 0, resetsAt: '' }, sevenDay: { utilization: 0, resetsAt: '' } };
}

function unavailableState(
  providerId: QuotaResolveProviderId,
  error: string,
  capturedAt: string,
): QuotaState {
  return {
    ...zeroWindows(),
    available: false,
    error,
    failureKind: 'unknown',
    providerId,
    capturedAt,
    ...(providerId === 'codex' ? { fiveHourLabel: 'Primary', sevenDayLabel: 'Secondary' } : {}),
  };
}

async function fetchFromApi(
  options: ResolveQuotaOptions,
  identity: ResolvedIdentity,
  capturedAt: string,
): Promise<QuotaState> {
  switch (options.providerId) {
    case 'claude-code': {
      const token = await (options.getClaudeAccessToken ?? defaultClaudeAccessToken)();
      if (!token) {
        return {
          ...zeroWindows(),
          available: false,
          error: CLAUDE_NO_CREDENTIALS_ERROR,
          failureKind: 'auth',
          providerId: 'claude-code',
          source: 'api',
          capturedAt,
        };
      }
      const state = await fetchQuota(token, { fetchImpl: options.fetchImpl });
      return { ...state, providerId: 'claude-code', source: 'api', capturedAt };
    }
    case 'codex':
      return fetchCodexQuotaFromApi({
        codexHome: options.codexHome,
        fetchImpl: options.fetchImpl,
        accessToken: options.codexAccessToken,
        accountId: identity.codexAccount?.providerAccountId,
        capturedAt,
      });
    case 'zai':
      return fetchZaiQuotaFromApi({ ...options.zai, fetchImpl: options.fetchImpl, capturedAt });
  }
}

function withAge<T extends QuotaState>(state: T, now: Date): T {
  if (state.ageMs !== undefined && state.freshness !== undefined) return state;
  const capturedMs = state.capturedAt ? Date.parse(state.capturedAt) : NaN;
  const ageMs = Number.isFinite(capturedMs) ? Math.max(0, now.getTime() - capturedMs) : undefined;
  return {
    ...state,
    ...(ageMs !== undefined ? { ageMs } : {}),
    freshness: classifyQuotaFreshness(ageMs),
  };
}

function enrich<T extends QuotaResolveProviderId>(
  providerId: T,
  state: QuotaState,
  identity: ResolvedIdentity,
): ProviderQuotaState<RuntimeProviderFor<T>> {
  switch (providerId) {
    case 'claude-code':
      return {
        ...withQuotaProjections(state),
        runtimeProvider: 'claude',
        providerId: 'claude-code',
        accountLabel: identity.accountLabel,
        accountDetail: identity.accountDetail,
      } as ProviderQuotaState<RuntimeProviderFor<T>>;
    case 'codex':
      return enrichCodexQuota(state, identity.codexAccount) as ProviderQuotaState<
        RuntimeProviderFor<T>
      >;
    default:
      return enrichZaiQuota(state) as ProviderQuotaState<RuntimeProviderFor<T>>;
  }
}

function snapshotResolution(state: QuotaState): QuotaResolution {
  if (state.freshness === 'fresh') return 'snapshot-fresh';
  if (state.freshness === 'aging') return 'snapshot-aging';
  return 'snapshot-stale';
}

/**
 * Resolve the current quota for one provider with the shared precedence
 * described at the top of this file.
 *
 * The result always has `runtimeProvider`, `resolution`, `freshness`, and
 * (when a capture time is known) `ageMs`; `failure` describes an API failure
 * even when older numbers were returned from a snapshot.
 */
export async function resolveQuota<T extends QuotaResolveProviderId>(
  options: ResolveQuotaOptions<T>,
): Promise<ResolvedQuota<T>> {
  const providerId = options.providerId;
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();
  const preferFresh = options.preferFresh ?? true;
  const allowApi = options.allowApi ?? true;
  const readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
  const writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;

  const identity = resolveIdentity(options);
  const finish = (state: QuotaState, resolution: QuotaResolution): ResolvedQuota<T> => {
    const enriched = withAge(enrich(providerId, state, identity), now);
    return {
      ...enriched,
      failure: enriched.failure ?? describeQuotaFailure(enriched),
      resolution,
    };
  };

  const stored = identity.accountId
    ? readSnapshot(snapshotProviderId(providerId), identity.accountId, now)
    : null;
  const snapshot = stored?.available ? stored : null;

  if (preferFresh && snapshot && snapshot.freshness === 'fresh') {
    return finish(snapshot, 'snapshot-fresh');
  }

  if (providerId === 'codex') {
    const local = resolveCodexQuotaFromLocalSources({
      workspacePath: options.workspacePath,
      provider: options.codexProvider,
      activeAccount: identity.codexAccount,
      codexHome: options.codexHome,
      // Only rollout hits count as "session-derived"; the snapshot fallback is
      // handled below so it can be labelled by age.
      readSnapshot: () => null,
      writeSnapshot,
    });
    if (local) return finish(local, 'session');
  }

  let apiState: QuotaState | null = null;
  if (allowApi) {
    apiState = await fetchFromApi(options, identity, capturedAt);
    if (apiState.available) {
      if (identity.accountId) {
        writeSnapshot(snapshotProviderId(providerId), identity.accountId, apiState);
      }
      return finish(apiState, 'api');
    }
  }

  if (snapshot) {
    const fallback = finish(snapshot, snapshotResolution(snapshot));
    return apiState ? { ...fallback, failure: describeQuotaFailure(apiState) } : fallback;
  }

  return finish(
    apiState ??
      unavailableState(
        providerId,
        stored
          ? 'The last persisted quota sample was unavailable.'
          : 'No quota data is available yet; run the provider once so a sample can be recorded.',
        capturedAt,
      ),
    'unavailable',
  );
}
