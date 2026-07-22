import { describe, expect, it, vi } from 'vitest';
import type { SessionProviderBase } from './providers/types';

const mocks = vi.hoisted(() => {
  const capabilities = {
    schemaVersion: 1 as const,
    provider: 'codex' as const,
    resume: { value: true, provenance: 'inferred' as const, confidence: 1, evidence: [] },
    forkLineage: { value: true, provenance: 'inferred' as const, confidence: 1, evidence: [] },
    quotaSource: {
      value: 'mixed' as const,
      provenance: 'inferred' as const,
      confidence: 1,
      evidence: [],
    },
    assetExtraction: {
      value: true,
      provenance: 'inferred' as const,
      confidence: 1,
      evidence: [],
    },
  };
  const read = vi.fn(() => Promise.resolve({ schemaVersion: 1 }));
  const dispose = vi.fn();
  const adapter = {
    schemaVersion: 1 as const,
    provider: 'codex' as const,
    capabilities,
    discover: vi.fn(),
    read,
    watch: vi.fn(),
    dispose,
  };
  return {
    adapter,
    createProviderSessionAdapterV1: vi.fn(() => adapter),
  };
});

vi.mock('./types/observedSessionV1', () => ({
  createProviderSessionAdapterV1: mocks.createProviderSessionAdapterV1,
}));

import { observedSessionSourceFromProvider } from './observedSessionCollector';

describe('observedSessionSourceFromProvider', () => {
  it('shares one provider adapter across capabilities, reads, and disposal', async () => {
    const provider = {
      id: 'codex',
      findAllSessions: () => ['/sessions/session-1.jsonl'],
      getSessionId: () => 'session-1',
      getSessionMetadata: () => ({ mtime: new Date('2026-07-22T00:00:00Z') }),
    } as SessionProviderBase;

    const source = observedSessionSourceFromProvider(provider, '/workspace/app');
    expect(mocks.createProviderSessionAdapterV1).toHaveBeenCalledOnce();
    expect(mocks.createProviderSessionAdapterV1).toHaveBeenCalledWith(provider);
    expect(source.capabilities).toBe(mocks.adapter.capabilities);

    await source.read({ sessionId: 'session-1', sourceKey: '/sessions/session-1.jsonl' });
    expect(mocks.adapter.read).toHaveBeenCalledOnce();
    expect(mocks.adapter.read).toHaveBeenCalledWith('/sessions/session-1.jsonl', '/workspace/app');

    source.dispose?.();
    expect(mocks.adapter.dispose).toHaveBeenCalledOnce();
  });
});
