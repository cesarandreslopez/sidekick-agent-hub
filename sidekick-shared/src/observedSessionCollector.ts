import { statSync } from 'node:fs';
import type { ObservedAgentSessionV1 } from './types/observedSessionV1';
import { createProviderSessionAdapterV1 } from './types/observedSessionV1';
import type { SessionProviderBase } from './providers/types';

export interface ObservedSessionReference {
  sessionId: string;
  /** Opaque source locator used only by the source implementation. Never emitted in diagnostics. */
  sourceKey?: string;
  fingerprintHint?: string;
}

export interface ObservedSessionCollectionSource<T = unknown> {
  providerId: string;
  discover(): Promise<ObservedSessionReference[]> | ObservedSessionReference[];
  read(reference: ObservedSessionReference): Promise<T> | T;
  dispose?(): void;
}

export type ObservedSessionDiagnosticKind =
  | 'provider-discovery-failed'
  | 'session-read-failed'
  | 'provider-recovered'
  | 'session-recovered';

/** Content-safe diagnostics: identifiers and retry metadata only. */
export interface ObservedSessionDiagnostic {
  kind: ObservedSessionDiagnosticKind;
  providerId: string;
  sessionId?: string;
  attempt?: number;
  retryAt?: number;
}

export interface ObservedSessionCollection<T = unknown> {
  providerId: string;
  sessionId: string;
  value: T;
}

export interface ObservedSessionCollectorOptions<T = unknown> {
  sources: ObservedSessionCollectionSource<T>[];
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  clock?: { now(): number };
  fingerprint?: (
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
  ) => Promise<string | null> | string | null;
  onObservation?: (observation: ObservedSessionCollection<T>) => void;
  onDiagnostic?: (diagnostic: ObservedSessionDiagnostic) => void;
}

interface FailureState {
  attempt: number;
  retryAt: number;
  fingerprint: string | null;
  reportedSignature: string;
}

/**
 * One-shot, host-scheduled observed-session collection with independent
 * provider/session isolation and bounded retry state.
 */
export class ObservedSessionCollector<T = unknown> {
  private readonly failures = new Map<string, FailureState>();
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: { now(): number };

  constructor(private readonly options: ObservedSessionCollectorOptions<T>) {
    this.initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 30_000);
    this.maxBackoffMs = Math.max(this.initialBackoffMs, options.maxBackoffMs ?? 5 * 60_000);
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async collect(): Promise<ObservedSessionCollection<T>[]> {
    const nested = await Promise.all(
      this.options.sources.map((source) => this.collectSource(source)),
    );
    return nested.flat();
  }

  reset(): void {
    this.failures.clear();
  }

  dispose(): void {
    for (const source of this.options.sources) {
      try {
        source.dispose?.();
      } catch {
        // Disposal is best-effort and isolated per source.
      }
    }
    this.reset();
  }

  private async collectSource(
    source: ObservedSessionCollectionSource<T>,
  ): Promise<ObservedSessionCollection<T>[]> {
    const discoveryKey = `${source.providerId}\0$discovery`;
    const discoveryFailure = this.failures.get(discoveryKey);
    if (discoveryFailure && this.clock.now() < discoveryFailure.retryAt) return [];
    let references: ObservedSessionReference[];
    try {
      references = await source.discover();
      this.recover(discoveryKey, 'provider-recovered', source.providerId);
    } catch (error) {
      this.fail(
        discoveryKey,
        'provider-discovery-failed',
        source.providerId,
        undefined,
        null,
        error,
      );
      return [];
    }

    const activeKeys = new Set(references.map((ref) => this.key(source.providerId, ref.sessionId)));
    for (const key of this.failures.keys()) {
      if (
        key.startsWith(`${source.providerId}\0`) &&
        !key.endsWith('$discovery') &&
        !activeKeys.has(key)
      ) {
        this.failures.delete(key);
      }
    }

    const rows = await Promise.all(
      references.map((reference) => this.collectSession(source, reference)),
    );
    return rows.filter((row): row is ObservedSessionCollection<T> => row !== null);
  }

  private async collectSession(
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
  ): Promise<ObservedSessionCollection<T> | null> {
    const key = this.key(source.providerId, reference.sessionId);
    const fingerprint = await this.fingerprint(source, reference);
    const prior = this.failures.get(key);
    if (prior && prior.fingerprint === fingerprint && this.clock.now() < prior.retryAt) return null;

    let value: T;
    try {
      value = await source.read(reference);
    } catch (error) {
      this.fail(
        key,
        'session-read-failed',
        source.providerId,
        reference.sessionId,
        fingerprint,
        error,
      );
      return null;
    }
    this.recover(key, 'session-recovered', source.providerId, reference.sessionId);
    const observation = { providerId: source.providerId, sessionId: reference.sessionId, value };
    try {
      this.options.onObservation?.(observation);
    } catch {
      // Host callbacks cannot turn a healthy provider read into a collection failure.
    }
    return observation;
  }

  private async fingerprint(
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
  ): Promise<string | null> {
    try {
      return this.options.fingerprint
        ? await this.options.fingerprint(source, reference)
        : (reference.fingerprintHint ?? null);
    } catch {
      return reference.fingerprintHint ?? null;
    }
  }

  private fail(
    key: string,
    kind: Extract<ObservedSessionDiagnosticKind, `${string}-failed`>,
    providerId: string,
    sessionId: string | undefined,
    fingerprint: string | null,
    error: unknown,
  ): void {
    const previous = this.failures.get(key);
    const signature = failureSignature(error);
    const fingerprintChanged = previous?.fingerprint !== fingerprint;
    const attempt = previous && !fingerprintChanged ? previous.attempt + 1 : 1;
    const delay = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** (attempt - 1));
    const retryAt = this.clock.now() + delay;
    const reportedSignature = previous?.reportedSignature ?? '';
    this.failures.set(key, {
      attempt,
      retryAt,
      fingerprint,
      reportedSignature: signature,
    });
    if (signature !== reportedSignature || fingerprintChanged) {
      this.emitDiagnostic({ kind, providerId, sessionId, attempt, retryAt });
    }
  }

  private recover(
    key: string,
    kind: Extract<ObservedSessionDiagnosticKind, `${string}-recovered`>,
    providerId: string,
    sessionId?: string,
  ): void {
    const prior = this.failures.get(key);
    if (!prior) return;
    this.failures.delete(key);
    this.emitDiagnostic({ kind, providerId, sessionId, attempt: prior.attempt });
  }

  private emitDiagnostic(diagnostic: ObservedSessionDiagnostic): void {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and never affect collection isolation.
    }
  }

  private key(providerId: string, sessionId: string): string {
    return `${providerId}\0${sessionId}`;
  }
}

/**
 * Adapt a provider using path-only discovery and independent adapter reads, so
 * one malformed session cannot reject discovery of its healthy siblings.
 */
export function observedSessionSourceFromProvider(
  provider: SessionProviderBase,
  cwd: string,
): ObservedSessionCollectionSource<ObservedAgentSessionV1> {
  const adapter = createProviderSessionAdapterV1(provider);
  return {
    providerId: provider.id,
    discover() {
      return provider.findAllSessions(cwd).map((sessionPath) => ({
        sessionId: provider.getSessionId(sessionPath),
        sourceKey: sessionPath,
        fingerprintHint:
          provider.getSessionMetadata?.(sessionPath)?.mtime.getTime().toString() ??
          fileFingerprint(sessionPath) ??
          undefined,
      }));
    },
    read(reference) {
      if (!reference.sourceKey) throw new Error('session source unavailable');
      return adapter.read(reference.sourceKey, cwd);
    },
    dispose: () => adapter.dispose(),
  };
}

/** Size/mtime fingerprint suitable for retry bypass; returns null for synthetic DB locators. */
export function fileFingerprint(sourcePath: string): string | null {
  try {
    const stat = statSync(sourcePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function failureSignature(error: unknown): string {
  if (error instanceof Error) return `${error.name}\0${error.message}`;
  return typeof error === 'string' ? error : Object.prototype.toString.call(error);
}
