import * as fs from 'node:fs';
import { statSync } from 'node:fs';
import type {
  ObservedAgentSessionV1,
  ProviderCapabilitiesV1,
  ProviderSessionAdapterV1Options,
} from './types/observedSessionV1';
import { createProviderSessionAdapterV1 } from './types/observedSessionV1';
import type { SessionProviderBase } from './providers/types';
import { refreshSessionActivityState } from './parsers/sessionActivityDetector';

export interface ObservedSessionFingerprintParts {
  sizeBytes: number;
  mtimeMs: number;
}

export interface ObservedSessionReference {
  sessionId: string;
  /** Opaque source locator used only by the source implementation. Never emitted in diagnostics. */
  sourceKey?: string;
  /** Backward-compatible opaque fingerprint. */
  fingerprintHint?: string;
  /** Structured fingerprint for consumers that previously parsed fingerprintHint. */
  fingerprintParts?: ObservedSessionFingerprintParts;
}

export interface ObservedSessionSourceSubscribeOptions {
  pollIntervalMs?: number;
}

export interface ObservedSessionCollectionSource<T = unknown> {
  providerId: string;
  discover(): Promise<ObservedSessionReference[]> | ObservedSessionReference[];
  read(reference: ObservedSessionReference): Promise<T> | T;
  refreshCached?(reference: ObservedSessionReference, value: T, observedAt: string): Promise<T> | T;
  /** Low-level invalidation signal; the collector performs fingerprint reconciliation. */
  subscribe?(
    listener: () => void,
    options?: ObservedSessionSourceSubscribeOptions,
  ): { dispose(): void };
  dispose?(): void;
}

export interface ProviderObservedSessionCollectionSource extends ObservedSessionCollectionSource<ObservedAgentSessionV1> {
  capabilities: ProviderCapabilitiesV1;
}

export type ObservedSessionDiagnosticKind =
  | 'provider-discovery-failed'
  | 'session-read-failed'
  | 'provider-recovered'
  | 'session-recovered';

export type ObservedSessionDiagnosticSeverity = 'info' | 'warning' | 'error';
export type ObservedSessionDiagnosticPhase = 'discover' | 'read' | 'recover';

/** Content-safe diagnostics: identifiers and retry metadata only. */
export interface ObservedSessionDiagnostic {
  kind: ObservedSessionDiagnosticKind;
  severity: ObservedSessionDiagnosticSeverity;
  phase: ObservedSessionDiagnosticPhase;
  providerId: string;
  sessionId?: string;
  attempt?: number;
  retryAt?: number;
}

export interface ObservedSessionCollection<T = unknown> {
  providerId: string;
  sessionId: string;
  value: T;
  fingerprint: string | null;
  fingerprintParts: ObservedSessionFingerprintParts | null;
  cacheHit: boolean;
  /** Time this observation was returned. */
  observedAt: string;
  /** Time content was last parsed; unchanged on a cache hit. */
  contentObservedAt: string;
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
  maxConcurrentReads?: number;
  yieldBetweenReads?: () => Promise<void> | void;
  onObservation?: (observation: ObservedSessionCollection<T>) => void;
  onDiagnostic?: (diagnostic: ObservedSessionDiagnostic) => void;
}

export type ObservedSessionChangeType = 'added' | 'changed' | 'removed';

export interface ObservedSessionChange {
  type: ObservedSessionChangeType;
  reference: ObservedSessionReference;
  previousFingerprint: string | null;
  previousFingerprintParts: ObservedSessionFingerprintParts | null;
  fingerprint: string | null;
  fingerprintParts: ObservedSessionFingerprintParts | null;
}

export interface ObservedSessionChangeBatch {
  providerId: string;
  changes: ObservedSessionChange[];
  observedAt: string;
}

export interface KnownObservedSessionFingerprint {
  providerId: string;
  sessionId: string;
  fingerprint: string;
  fingerprintParts?: ObservedSessionFingerprintParts;
}

export interface ObservedSessionSubscribeOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  knownFingerprints?: readonly KnownObservedSessionFingerprint[];
}

interface FailureState {
  attempt: number;
  retryAt: number;
  fingerprint: string | null;
  reportedSignature: string;
}

interface FingerprintValue {
  value: string | null;
  parts: ObservedSessionFingerprintParts | null;
}

interface CacheEntry<T> {
  value: T;
  fingerprint: string;
  fingerprintParts: ObservedSessionFingerprintParts | null;
  contentObservedAt: string;
}

const DEFAULT_MAX_CONCURRENT_READS = 4;
const MAX_CONCURRENT_READS = 16;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Fail-soft observed-session collection with fingerprint-keyed parse caching,
 * cooperative reads, and optional provider-level subscriptions.
 */
export class ObservedSessionCollector<T = unknown> {
  private readonly failures = new Map<string, FailureState>();
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly subscriptions = new Set<{ dispose(): void }>();
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: { now(): number };
  private readonly maxConcurrentReads: number;
  private readonly yieldBetweenReads: () => Promise<void>;

  constructor(private readonly options: ObservedSessionCollectorOptions<T>) {
    this.initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 30_000);
    this.maxBackoffMs = Math.max(this.initialBackoffMs, options.maxBackoffMs ?? 5 * 60_000);
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxConcurrentReads = Math.min(
      MAX_CONCURRENT_READS,
      Math.max(1, Math.floor(options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS)),
    );
    this.yieldBetweenReads = async () => {
      if (options.yieldBetweenReads) {
        await options.yieldBetweenReads();
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
  }

  async collect(): Promise<ObservedSessionCollection<T>[]> {
    const nested = await Promise.all(
      this.options.sources.map((source) => this.collectSource(source)),
    );
    return nested.flat();
  }

  /**
   * Subscribe to debounced provider changes. The listener receives fingerprints
   * only; call collect() to consume changed sessions through the parse cache.
   */
  subscribe(
    listener: (batch: ObservedSessionChangeBatch) => void,
    options: ObservedSessionSubscribeOptions = {},
  ): { dispose(): void } {
    const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const known = new Map<
      string,
      { fingerprint: string; parts: ObservedSessionFingerprintParts | null }
    >();
    for (const item of options.knownFingerprints ?? []) {
      known.set(this.key(item.providerId, item.sessionId), {
        fingerprint: item.fingerprint,
        parts: item.fingerprintParts ?? null,
      });
    }
    for (const [key, entry] of this.cache) {
      known.set(key, { fingerprint: entry.fingerprint, parts: entry.fingerprintParts });
    }

    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let reconciling = false;
    let pending = false;
    const sourceDisposables: Array<{ dispose(): void }> = [];

    const reconcile = async (): Promise<void> => {
      if (disposed) return;
      if (reconciling) {
        pending = true;
        return;
      }
      reconciling = true;
      try {
        do {
          pending = false;
          for (const source of this.options.sources) {
            if (disposed) break;
            const batch = await this.reconcileSource(source, known);
            if (batch && batch.changes.length > 0) {
              try {
                listener(batch);
              } catch {
                // Subscriber failures cannot stop reconciliation.
              }
            }
          }
        } while (pending && !disposed);
      } finally {
        reconciling = false;
      }
    };

    const schedule = (): void => {
      if (disposed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void reconcile();
      }, debounceMs);
      debounceTimer.unref?.();
    };

    let needsCollectorPoll = false;
    for (const source of this.options.sources) {
      if (source.subscribe) {
        try {
          sourceDisposables.push(source.subscribe(schedule, { pollIntervalMs }));
        } catch {
          // The collector-level poll below remains the correctness fallback.
          needsCollectorPoll = true;
        }
      } else {
        needsCollectorPoll = true;
      }
    }
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (needsCollectorPoll && pollIntervalMs > 0) {
      pollTimer = setInterval(schedule, pollIntervalMs);
      pollTimer.unref?.();
    }

    schedule();
    const disposable = {
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        for (const item of sourceDisposables) {
          try {
            item.dispose();
          } catch {
            // Disposal is best effort.
          }
        }
        this.subscriptions.delete(disposable);
      },
    };
    this.subscriptions.add(disposable);
    return disposable;
  }

  reset(): void {
    this.failures.clear();
    this.cache.clear();
  }

  dispose(): void {
    for (const subscription of [...this.subscriptions]) subscription.dispose();
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
    this.evictMissing(source.providerId, activeKeys);

    const rows = await this.mapWithConcurrency(references, async (reference) => {
      const result = await this.collectSession(source, reference);
      await this.yieldBetweenReads();
      return result;
    });
    return rows.filter((row): row is ObservedSessionCollection<T> => row !== null);
  }

  private async collectSession(
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
  ): Promise<ObservedSessionCollection<T> | null> {
    const key = this.key(source.providerId, reference.sessionId);
    const fingerprint = await this.fingerprint(source, reference);
    const priorFailure = this.failures.get(key);
    if (
      priorFailure &&
      priorFailure.fingerprint === fingerprint.value &&
      this.clock.now() < priorFailure.retryAt
    ) {
      return null;
    }

    const observedAt = new Date(this.clock.now()).toISOString();
    const cached = fingerprint.value === null ? undefined : this.cache.get(key);
    if (cached && cached.fingerprint === fingerprint.value) {
      let value = cached.value;
      try {
        if (source.refreshCached) {
          value = await source.refreshCached(reference, cached.value, observedAt);
        }
      } catch {
        value = cached.value;
      }
      cached.value = value;
      cached.fingerprintParts = fingerprint.parts;
      const observation = this.makeObservation(
        source,
        reference,
        value,
        fingerprint,
        true,
        observedAt,
        cached.contentObservedAt,
      );
      this.emitObservation(observation);
      return observation;
    }

    let value: T;
    try {
      value = await source.read(reference);
    } catch (error) {
      this.fail(
        key,
        'session-read-failed',
        source.providerId,
        reference.sessionId,
        fingerprint.value,
        error,
      );
      return null;
    }
    this.recover(key, 'session-recovered', source.providerId, reference.sessionId);
    const contentObservedAt = contentTimestamp(value) ?? observedAt;
    if (fingerprint.value !== null) {
      this.cache.set(key, {
        value,
        fingerprint: fingerprint.value,
        fingerprintParts: fingerprint.parts,
        contentObservedAt,
      });
    }
    const observation = this.makeObservation(
      source,
      reference,
      value,
      fingerprint,
      false,
      observedAt,
      contentObservedAt,
    );
    this.emitObservation(observation);
    return observation;
  }

  private makeObservation(
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
    value: T,
    fingerprint: FingerprintValue,
    cacheHit: boolean,
    observedAt: string,
    contentObservedAt: string,
  ): ObservedSessionCollection<T> {
    return {
      providerId: source.providerId,
      sessionId: reference.sessionId,
      value,
      fingerprint: fingerprint.value,
      fingerprintParts: fingerprint.parts,
      cacheHit,
      observedAt,
      contentObservedAt,
    };
  }

  private emitObservation(observation: ObservedSessionCollection<T>): void {
    try {
      this.options.onObservation?.(observation);
    } catch {
      // Host callbacks cannot turn a healthy provider read into a collection failure.
    }
  }

  private async reconcileSource(
    source: ObservedSessionCollectionSource<T>,
    known: Map<string, { fingerprint: string; parts: ObservedSessionFingerprintParts | null }>,
  ): Promise<ObservedSessionChangeBatch | null> {
    let references: ObservedSessionReference[];
    try {
      references = await source.discover();
    } catch {
      return null;
    }
    const changes: ObservedSessionChange[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const key = this.key(source.providerId, reference.sessionId);
      seen.add(key);
      const current = await this.fingerprint(source, reference);
      if (current.value === null) continue;
      const previous = known.get(key);
      if (!previous || previous.fingerprint !== current.value) {
        changes.push({
          type: previous ? 'changed' : 'added',
          reference,
          previousFingerprint: previous?.fingerprint ?? null,
          previousFingerprintParts: previous?.parts ?? null,
          fingerprint: current.value,
          fingerprintParts: current.parts,
        });
      }
      known.set(key, { fingerprint: current.value, parts: current.parts });
    }

    for (const [key, previous] of [...known]) {
      if (!key.startsWith(`${source.providerId}\0`) || seen.has(key)) continue;
      const sessionId = key.slice(source.providerId.length + 1);
      changes.push({
        type: 'removed',
        reference: { sessionId },
        previousFingerprint: previous.fingerprint,
        previousFingerprintParts: previous.parts,
        fingerprint: null,
        fingerprintParts: null,
      });
      known.delete(key);
    }
    return {
      providerId: source.providerId,
      changes,
      observedAt: new Date(this.clock.now()).toISOString(),
    };
  }

  private async fingerprint(
    source: ObservedSessionCollectionSource<T>,
    reference: ObservedSessionReference,
  ): Promise<FingerprintValue> {
    let value = reference.fingerprintHint ?? null;
    try {
      if (this.options.fingerprint) value = await this.options.fingerprint(source, reference);
    } catch {
      // Retain the reference hint.
    }
    const parts = reference.fingerprintParts ?? parseFingerprintParts(value);
    return { value, parts };
  }

  private evictMissing(providerId: string, activeKeys: Set<string>): void {
    for (const key of this.failures.keys()) {
      if (
        key.startsWith(`${providerId}\0`) &&
        !key.endsWith('$discovery') &&
        !activeKeys.has(key)
      ) {
        this.failures.delete(key);
      }
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${providerId}\0`) && !activeKeys.has(key)) this.cache.delete(key);
    }
  }

  private async mapWithConcurrency<A, B>(
    values: readonly A[],
    mapper: (value: A) => Promise<B>,
  ): Promise<B[]> {
    const results = new Array<B>(values.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(this.maxConcurrentReads, values.length) },
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= values.length) return;
          results[index] = await mapper(values[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
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
    this.failures.set(key, { attempt, retryAt, fingerprint, reportedSignature: signature });
    if (signature !== reportedSignature || fingerprintChanged) {
      this.emitDiagnostic({
        kind,
        severity: 'error',
        phase: kind === 'provider-discovery-failed' ? 'discover' : 'read',
        providerId,
        sessionId,
        attempt,
        retryAt,
      });
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
    this.emitDiagnostic({
      kind,
      severity: 'info',
      phase: 'recover',
      providerId,
      sessionId,
      attempt: prior.attempt,
    });
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
  options: ProviderSessionAdapterV1Options = {},
): ProviderObservedSessionCollectionSource {
  const adapter = options.observationOnly
    ? createProviderSessionAdapterV1(provider, { observationOnly: true })
    : createProviderSessionAdapterV1(provider);
  const referenceFromPath = (
    sessionPath: string,
    sessionId = provider.getSessionId(sessionPath),
    suppliedParts?: ObservedSessionFingerprintParts,
  ): ObservedSessionReference => {
    const metadata = suppliedParts ? null : provider.getSessionMetadata?.(sessionPath);
    const parts =
      suppliedParts ??
      fileFingerprintParts(sessionPath) ??
      (metadata ? { sizeBytes: 0, mtimeMs: metadata.mtime.getTime() } : null);
    return {
      sessionId,
      sourceKey: sessionPath,
      fingerprintHint: parts ? fingerprintString(parts) : undefined,
      fingerprintParts: parts ?? undefined,
    };
  };
  const discover = async (): Promise<ObservedSessionReference[]> => {
    if (provider.listSessionFilesAsync) {
      try {
        const files = await provider.listSessionFilesAsync(cwd);
        return files.map((info) => {
          const mtimeMs = info.mtime.getTime();
          const suppliedParts =
            info.sizeBytes !== undefined && Number.isFinite(mtimeMs)
              ? { sizeBytes: info.sizeBytes, mtimeMs }
              : undefined;
          return referenceFromPath(
            info.path,
            info.sessionId ?? provider.getSessionId(info.path),
            suppliedParts,
          );
        });
      } catch {
        // Retain compatibility with third-party providers whose optional async
        // enumerator is temporarily unavailable.
      }
    }
    return provider.findAllSessions(cwd).map((sessionPath) => {
      const metadata = provider.getSessionMetadata?.(sessionPath);
      const parts =
        fileFingerprintParts(sessionPath) ??
        (metadata ? { sizeBytes: 0, mtimeMs: metadata.mtime.getTime() } : null);
      return {
        sessionId: provider.getSessionId(sessionPath),
        sourceKey: sessionPath,
        fingerprintHint: parts ? fingerprintString(parts) : undefined,
        fingerprintParts: parts ?? undefined,
      };
    });
  };

  return {
    providerId: provider.id,
    capabilities: adapter.capabilities,
    discover,
    async read(reference) {
      if (!reference.sourceKey) throw new Error('session source unavailable');
      return adapter.read(reference.sourceKey, cwd);
    },
    refreshCached(reference, cached, observedAt) {
      const mtimeMs = reference.fingerprintParts?.mtimeMs ?? Date.parse(cached.observedAt);
      const activity = refreshSessionActivityState(cached.activity.value, mtimeMs);
      return {
        ...cached,
        activity: { ...cached.activity, value: activity },
        observedAt,
      };
    },
    subscribe(listener, subscribeOptions = {}) {
      return subscribeToProviderRoot(provider, listener, subscribeOptions.pollIntervalMs ?? 0);
    },
    dispose: () => adapter.dispose(),
  };
}

/** Structured size/mtime fingerprint; returns null for inaccessible or synthetic paths. */
export function fileFingerprintParts(sourcePath: string): ObservedSessionFingerprintParts | null {
  try {
    const stat = statSync(sourcePath);
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Size/mtime fingerprint suitable for retry bypass; returns null for synthetic DB locators. */
export function fileFingerprint(sourcePath: string): string | null {
  const parts = fileFingerprintParts(sourcePath);
  return parts ? fingerprintString(parts) : null;
}

function fingerprintString(parts: ObservedSessionFingerprintParts): string {
  return `${parts.sizeBytes}:${parts.mtimeMs}`;
}

function parseFingerprintParts(value: string | null): ObservedSessionFingerprintParts | null {
  if (!value) return null;
  const match = value.match(/^([0-9]+):([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return null;
  const sizeBytes = Number(match[1]);
  const mtimeMs = Number(match[2]);
  return Number.isFinite(sizeBytes) && Number.isFinite(mtimeMs) ? { sizeBytes, mtimeMs } : null;
}

function contentTimestamp(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as { contentObservedAt?: unknown }).contentObservedAt;
  return typeof candidate === 'string' ? candidate : null;
}

function subscribeToProviderRoot(
  provider: SessionProviderBase,
  listener: () => void,
  pollIntervalMs: number,
): { dispose(): void } {
  const watchers = new Set<fs.FSWatcher>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let roots: string[];
  try {
    roots = provider.getWatchRoots?.() ?? [provider.getProjectsBaseDir()];
  } catch {
    roots = [];
  }
  for (const root of new Set(roots)) {
    try {
      const watcher = fs.watch(root, { persistent: false, recursive: true }, listener);
      watchers.add(watcher);
      watcher.on('error', () => {
        watchers.delete(watcher);
        try {
          watcher.close();
        } catch {
          // Catch-up polling remains active.
        }
      });
    } catch {
      // Polling remains the documented fallback.
    }
  }
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(listener, pollIntervalMs);
    pollTimer.unref?.();
  }
  return {
    dispose: () => {
      for (const watcher of watchers) watcher.close();
      watchers.clear();
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}

function failureSignature(error: unknown): string {
  if (error instanceof Error) return `${error.name}\0${error.message}`;
  return typeof error === 'string' ? error : Object.prototype.toString.call(error);
}
