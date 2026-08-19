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
      expect.objectContaining({
        providerId: 'healthy-provider',
        sessionId: 'good',
        value: 'healthy observation',
        cacheHit: false,
      }),
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'provider-discovery-failed',
      'session-read-failed',
    ]);
    expect(diagnostics.map(({ severity, phase }) => ({ severity, phase }))).toEqual([
      { severity: 'error', phase: 'discover' },
      { severity: 'error', phase: 'read' },
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
      expect.objectContaining({
        providerId: 'codex',
        sessionId: 'session-1',
        value: 'recovered',
      }),
    ]);
    expect(diagnostics.at(-1)).toMatchObject({
      kind: 'session-recovered',
      severity: 'info',
      phase: 'recover',
      attempt: 1,
    });
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

  it('does zero content reads for an unchanged fingerprint and exposes its parts', async () => {
    let now = 1_000;
    let reads = 0;
    const collector = new ObservedSessionCollector<{ usage: number }>({
      clock: { now: () => now },
      sources: [
        {
          providerId: 'codex',
          discover: () => [
            {
              sessionId: 'session-1',
              fingerprintHint: '42:900',
              fingerprintParts: { sizeBytes: 42, mtimeMs: 900 },
            },
          ],
          read: () => {
            reads++;
            return { usage: 7 };
          },
        },
      ],
    });

    const first = await collector.collect();
    now = 2_000;
    const second = await collector.collect();

    expect(reads).toBe(1);
    expect(first[0]).toMatchObject({
      cacheHit: false,
      fingerprint: '42:900',
      fingerprintParts: { sizeBytes: 42, mtimeMs: 900 },
      contentObservedAt: '1970-01-01T00:00:01.000Z',
    });
    expect(second[0]).toMatchObject({
      cacheHit: true,
      observedAt: '1970-01-01T00:00:02.000Z',
      contentObservedAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it('coalesces watcher signals into changed-since batches without losing the latest state', async () => {
    let fingerprint = '1:1';
    let invalidate: (() => void) | undefined;
    const batches: Array<{ previous: string | null; next: string | null }> = [];
    const collector = new ObservedSessionCollector({
      sources: [
        {
          providerId: 'opencode',
          discover: () => [{ sessionId: 'session-1', fingerprintHint: fingerprint }],
          read: () => null,
          subscribe: (listener) => {
            invalidate = listener;
            return { dispose: () => undefined };
          },
        },
      ],
    });
    const subscription = collector.subscribe(
      (batch) => {
        for (const change of batch.changes) {
          batches.push({ previous: change.previousFingerprint, next: change.fingerprint });
        }
      },
      {
        debounceMs: 0,
        pollIntervalMs: 0,
        knownFingerprints: [{ providerId: 'opencode', sessionId: 'session-1', fingerprint: '1:1' }],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    fingerprint = '2:2';
    invalidate?.();
    fingerprint = '3:3';
    invalidate?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(batches).toEqual([{ previous: '1:1', next: '3:3' }]);
    subscription.dispose();
    collector.dispose();
  });
});
