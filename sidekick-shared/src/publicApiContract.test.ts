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
  PendingUserRequestV1,
  SessionEvidenceRefV1,
} from './index';

const contractGroups = {
  quota: [
    'resolveCodexQuota',
    'CodexQuotaWatcher',
    'readQuotaHistoryDailyBuckets',
    'readQuotaSnapshot',
  ],
  accounts: ['ensureDefaultAccounts', 'getActiveAccountStatus'],
  sessions: ['SessionMonitor', 'EventAggregator', 'extractSessionEvents', 'JsonlParser'],
  assets: ['gatherAssetsForCwd'],
  cost: ['calculateCost', 'getModelContextWindowSize'],
  turns: ['reasoningSummary', 'segmentAssistantTurn', 'extractTurnSubagents'],
  observedSessions: ['createProviderSessionAdapterV1', 'derivePendingUserRequestV1'],
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
      PendingUserRequestV1?,
      SessionEvidenceRefV1?,
    ] = [session, context];
    expect(compileOnly).toHaveLength(2);
  });
});
