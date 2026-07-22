import { describe, expect, it } from 'vitest';
import {
  ObservedSessionCollector,
  type ObservedSessionCollectionSource,
  type ObservedSessionDiagnostic,
} from './observedSessionCollector';

describe('ObservedSessionCollector', () => {
  it('isolates provider discovery and individual session reads', async () => {
    const diagnostics: ObservedSessionDiagnostic[] = [];
    const sources: ObservedSessionCollectionSource<string>[] = [
      {
        providerId: 'broken-provider',
        discover: () => {
          throw new Error('secret discovery details');
        },
        read: () => 'never',
      },
      {
        providerId: 'healthy-provider',
        discover: () => [{ sessionId: 'bad' }, { sessionId: 'good' }],
        read: ({ sessionId }) => {
          if (sessionId === 'bad') throw new Error('private transcript text');
          return 'healthy observation';
        },
      },
    ];
    const collector = new ObservedSessionCollector({
      sources,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(collector.collect()).resolves.toEqual([
      { providerId: 'healthy-provider', sessionId: 'good', value: 'healthy observation' },
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'provider-discovery-failed',
      'session-read-failed',
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret discovery details');
    expect(JSON.stringify(diagnostics)).not.toContain('private transcript text');
  });

  it('backs off, suppresses duplicate failures, bypasses delay on fingerprint change, and reports recovery', async () => {
    let now = 1_000;
    let fingerprint = '1:1';
    let shouldFail = true;
    let reads = 0;
    const diagnostics: ObservedSessionDiagnostic[] = [];
    const source: ObservedSessionCollectionSource<string> = {
      providerId: 'codex',
      discover: () => [{ sessionId: 'session-1', fingerprintHint: fingerprint }],
      read: () => {
        reads++;
        if (shouldFail) throw new Error('same failure');
        return 'recovered';
      },
    };
    const collector = new ObservedSessionCollector({
      sources: [source],
      clock: { now: () => now },
      initialBackoffMs: 30_000,
      maxBackoffMs: 300_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(await collector.collect()).toEqual([]);
    expect(reads).toBe(1);
    expect(diagnostics[0]).toMatchObject({ attempt: 1, retryAt: 31_000 });

    await collector.collect();
    expect(reads).toBe(1);
    now = 31_000;
    await collector.collect();
    expect(reads).toBe(2);
    expect(diagnostics).toHaveLength(1);

    fingerprint = '2:2';
    await collector.collect();
    expect(reads).toBe(3);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatchObject({ kind: 'session-read-failed', attempt: 1 });

    shouldFail = false;
    fingerprint = '3:3';
    await expect(collector.collect()).resolves.toEqual([
      { providerId: 'codex', sessionId: 'session-1', value: 'recovered' },
    ]);
    expect(diagnostics.at(-1)).toMatchObject({ kind: 'session-recovered', attempt: 1 });
  });

  it('caps exponential retry delays', async () => {
    let now = 0;
    let reads = 0;
    const diagnostics: ObservedSessionDiagnostic[] = [];
    const collector = new ObservedSessionCollector({
      sources: [
        {
          providerId: 'opencode',
          discover: () => [{ sessionId: 'session-1', fingerprintHint: 'stable' }],
          read: () => {
            reads++;
            throw new Error(`failure-${reads}`);
          },
        },
      ],
      clock: { now: () => now },
      initialBackoffMs: 10,
      maxBackoffMs: 25,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const attemptTimes = [0, 10, 30, 55];
    for (const next of attemptTimes) {
      now = next;
      await collector.collect();
    }
    expect(
      diagnostics.map((diagnostic, index) => diagnostic.retryAt! - attemptTimes[index]),
    ).toEqual([10, 20, 25, 25]);
  });
});
