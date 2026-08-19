import { describe, expect, it } from 'vitest';
import * as api from './index';
import type {
  ActiveAccountStatus,
  AggregatedMetrics,
  ContextAttribution,
  QuotaHistoryDailyBucket,
  QuotaState,
  SessionEvent,
  ObservedAgentSessionV1,
  ProviderCapabilitiesV1,
  ProviderSessionAdapterV1,
  ProviderObservedSessionCollectionSource,
  PendingUserRequestV1,
  SessionEvidenceRefV1,
  CanonicalSessionTranscript,
  TranscriptSourceProvenance,
  ResolvedModelCatalogSnapshot,
  ResolvedModelCatalogEntry,
  ImportResolvedModelCatalogResult,
  ResolvedModelContextWindow,
  ModelContextWindowProvenance,
  ModelCatalogMatch,
  ResolvedModelPricing,
  ModelPricingProvenance,
  ModelPricingMatch,
  ObservedSessionChangeBatch,
  ObservedSessionChange,
  ObservedSessionChangeType,
  ObservedSessionFingerprintParts,
  ObservedSessionSubscribeOptions,
  KnownObservedSessionFingerprint,
  SessionProviderDiagnostic,
  SessionProviderDiagnosticKind,
  SessionProviderDiagnosticPhase,
  SessionProviderDiagnosticSeverity,
  SessionProviderOptions,
  ProviderOperationStatus,
  ProviderRuntimeStatus,
  CreateSessionProvidersOptions,
  CreateSessionProvidersResult,
  SessionMonitorSubscribeOptions,
  AsyncSessionPreviewOptions,
  ListSessionPreviewsAsyncOptions,
  ReadSessionPreviewAsyncOptions,
  SessionPreviewListResult,
  SessionPreviewReadResult,
  AccountsChangedEvent,
  OnAccountsChangedOptions,
  ProviderSessionAdapterV1Options,
} from './index';

const contractGroups = {
  quota: [
    'resolveCodexQuota',
    'CodexQuotaWatcher',
    'readQuotaHistoryDailyBuckets',
    'readQuotaSnapshot',
  ],
  accounts: [
    'ensureDefaultAccounts',
    'getActiveAccountStatus',
    'getAccountLoginStatusAsync',
    'finalizeAccountLoginAsync',
    'switchAccountAsync',
    'prepareCodexAccountAsync',
    'finalizeCodexAccountAsync',
    'switchToCodexAccountAsync',
    'onAccountsChanged',
  ],
  writers: [
    'atomicWriteJson',
    'atomicWriteJsonSync',
    'atomicWriteFileSync',
    'updateJsonStoreAtomic',
    'updateJsonStoreAtomicSync',
    'withFileLockSync',
  ],
  sessions: [
    'SessionMonitor',
    'EventAggregator',
    'extractSessionEvents',
    'JsonlParser',
    'createSessionProviders',
    'refreshSessionActivityState',
  ],
  assets: ['gatherAssetsForCwd'],
  cost: [
    'calculateCost',
    'normalizeProviderUsage',
    'extractNormalizedUsage',
    'calculateNormalizedUsageCost',
    'getModelContextWindowSize',
    'resolveModelContextWindow',
    'resolveModelPricing',
    'exportResolvedModelCatalog',
    'importResolvedModelCatalog',
    'registerModelAlias',
    'resolveModelAlias',
  ],
  estimation: ['estimateTextTokens', 'estimateSerializedTokens'],
  transcripts: ['projectSessionTranscript', 'listRecentSessions', 'readSessionTranscript'],
  turns: ['reasoningSummary', 'segmentAssistantTurn', 'extractTurnSubagents'],
  observedSessions: ['createProviderSessionAdapterV1', 'derivePendingUserRequestV1'],
  collection: [
    'ObservedSessionCollector',
    'observedSessionSourceFromProvider',
    'fileFingerprint',
    'fileFingerprintParts',
  ],
  nativeSessionFiles: [
    'encodeClaudeWorkspacePath',
    'getClaudeSessionDirectory',
    'findCodexRolloutFile',
    'readCodexHistory',
    'listSessionPreviews',
    'listSessionPreviewsAsync',
    'readSessionPreview',
    'readSessionPreviewAsync',
    'parseMcpToolName',
  ],
} as const;

describe('public API consumer contracts', () => {
  for (const [contract, names] of Object.entries(contractGroups)) {
    it(`preserves the consumer-facing ${contract} contract`, () => {
      for (const name of names) {
        expect(api, `${contract} contract is missing export ${name}`).toHaveProperty(name);
        expect(
          typeof (api as Record<string, unknown>)[name],
          `${contract} contract export ${name} is not callable`,
        ).toBe('function');
      }
    });
  }

  it('preserves the consumer-facing data shapes', () => {
    const session: SessionEvent = {
      type: 'assistant',
      timestamp: '2026-07-18T00:00:00.000Z',
      message: { role: 'assistant' },
    };
    const context: ContextAttribution = {
      systemPrompt: 0,
      userMessages: 0,
      assistantResponses: 0,
      thinking: 0,
      toolInputs: 0,
      toolOutputs: 0,
      other: 0,
    };
    const compileOnly: [
      SessionEvent,
      ContextAttribution,
      AggregatedMetrics?,
      QuotaState?,
      ActiveAccountStatus?,
      QuotaHistoryDailyBucket?,
      ObservedAgentSessionV1?,
      ProviderCapabilitiesV1?,
      ProviderSessionAdapterV1?,
      ProviderObservedSessionCollectionSource?,
      PendingUserRequestV1?,
      SessionEvidenceRefV1?,
      CanonicalSessionTranscript?,
      TranscriptSourceProvenance?,
      ResolvedModelCatalogSnapshot?,
      ResolvedModelCatalogEntry?,
      ImportResolvedModelCatalogResult?,
      ResolvedModelContextWindow?,
      ModelContextWindowProvenance?,
      ModelCatalogMatch?,
      ResolvedModelPricing?,
      ModelPricingProvenance?,
      ModelPricingMatch?,
      ObservedSessionChangeBatch?,
      ObservedSessionChange?,
      ObservedSessionChangeType?,
      ObservedSessionFingerprintParts?,
      ObservedSessionSubscribeOptions?,
      KnownObservedSessionFingerprint?,
      SessionProviderDiagnostic?,
      SessionProviderDiagnosticKind?,
      SessionProviderDiagnosticPhase?,
      SessionProviderDiagnosticSeverity?,
      SessionProviderOptions?,
      ProviderOperationStatus?,
      ProviderRuntimeStatus?,
      CreateSessionProvidersOptions?,
      CreateSessionProvidersResult?,
      SessionMonitorSubscribeOptions?,
      AsyncSessionPreviewOptions?,
      ListSessionPreviewsAsyncOptions?,
      ReadSessionPreviewAsyncOptions?,
      SessionPreviewListResult?,
      SessionPreviewReadResult?,
      AccountsChangedEvent?,
      OnAccountsChangedOptions?,
      ProviderSessionAdapterV1Options?,
    ] = [session, context];
    expect(compileOnly).toHaveLength(2);
  });

  it('exports provider-id unions as stable runtime values', () => {
    expect(api.SESSION_PROVIDER_IDS).toEqual(['claude-code', 'opencode', 'codex']);
    expect(api.ACCOUNT_PROVIDER_IDS).toEqual(['claude-code', 'codex']);
    expect(api.QUOTA_PROVIDER_IDS).toEqual(['claude-code', 'codex', 'zai']);
    expect(api.RUNTIME_QUOTA_PROVIDER_IDS).toEqual(['claude', 'codex', 'zai']);
    expect(api.MODEL_PROVIDER_IDS).toEqual(['anthropic', 'openai', 'google', 'unknown']);
    expect(api.RESOLVED_MODEL_CATALOG_SCHEMA_VERSION).toBe(1);
  });

  // The README's examples had drifted from these signatures — `readTasks` was
  // documented with the wrong first argument and no `await`, and
  // `readClaudeMaxCredentials` without one. Pinning the shapes here means a
  // signature change breaks a test instead of silently re-rotting the docs.
  it('matches the shapes the README documents', () => {
    const readmeShapes:
      | [
          // readTasks(project, opts?) => Promise<PersistedTask[]>
          Parameters<typeof api.readTasks>[0],
          Awaited<ReturnType<typeof api.readTasks>>,
          // readClaudeMaxCredentials() => Promise<... | null>
          Awaited<ReturnType<typeof api.readClaudeMaxCredentials>>,
          // getModelInfo(id).{family,version,contextWindow}
          ReturnType<typeof api.getModelInfo>,
          // hydratePricingCatalog() takes no required argument
          Parameters<typeof api.hydratePricingCatalog>[0],
          // normalizeProviderUsage -> calculateNormalizedUsageCost -> formatCost
          ReturnType<typeof api.normalizeProviderUsage>,
          ReturnType<typeof api.calculateNormalizedUsageCost>,
          ReturnType<typeof api.setConfigDir>,
        ]
      | undefined = undefined;
    expect(readmeShapes).toBeUndefined();

    // resolveProjectIdentity output must be accepted by readTasks — this is
    // the specific correction the README needed.
    const project = api.resolveProjectIdentity(process.cwd());
    const accepted: Parameters<typeof api.readTasks>[0] = project;
    expect(accepted).toBe(project);

    // hydratePricingCatalog's cacheDir is optional, so it defaults to the
    // config dir rather than forcing a literal path into consumer code.
    expect(api.hydratePricingCatalog).toBeTypeOf('function');
    expect(api.readClaudeMaxAccessTokenSync).toBeTypeOf('function');
  });
});
