import * as fs from 'node:fs';
import type {
  ObservedAgentSessionV1,
  ProviderCapabilitiesV1,
  ProviderSessionAdapterV1Options,
} from './types/observedSessionV1';
import {
  createProviderSessionAdapterV1,
  getObservedActivityReason,
} from './types/observedSessionV1';
import type { SessionProviderBase, WatchedSessionFile } from './providers/types';
import { refreshSessionActivityState } from './parsers/sessionActivityDetector';
import { fileFingerprintParts, fingerprintString } from './sessionFingerprint';
import type { ObservedSessionFingerprintParts } from './sessionFingerprint';

export { fileFingerprint, fileFingerprintParts } from './sessionFingerprint';
export type { ObservedSessionFingerprintParts } from './sessionFingerprint';

export interface ObservedSessionReference {
  sessionId: string;
  /** Opaque source locator used only by the source implementation. Never emitted in diagnostics. */
  sourceKey?: string;
  /** Backward-compatible opaque fingerprint. */
  fingerprintHint?: string;
  /** Structured fingerprint for consumers that previously parsed fingerprintHint. */
  fingerprintParts?: ObservedSessionFingerprintParts;
}

/** Payload-free counters a source may fill while discovering. */
export interface ObservedSessionDiscoveryStats {
  directoriesListed?: number;
  directoriesStatted?: number;
  filesStatted?: number;
}

/** Optional bounds for `discover()`. Sources that ignore them still satisfy the contract. */
export interface ObservedSessionDiscoverOptions {
  /** Return at most this many references, newest first. */
  limit?: number;
  /** Only references modified at or after this epoch-ms. */
  since?: number;
  /** Out-param: fields the source leaves undefined are omitted from diagnostics. */
  stats?: ObservedSessionDiscoveryStats;
}

/**
 * What a source's `subscribe()` listener receives. A recursive `fs.watch`
 * supplies a root-relative `filename` that lets the collector reconcile one
 * session instead of rediscovering the provider.
 */
export interface ObservedSessionSourceSignal {
  trigger?: 'event' | 'poll';
  /** Watch root the event was observed under. */
  root?: string;
  /** Root-relative path from `fs.watch`; null or undefined when unknown. */
  filename?: string | null;
  eventType?: string;
}

/**
 * A string arrives when a source hands the listener straight to `fs.watch`
 * (the event type); the collector treats anything but a signal object as
 * "unknown" and falls back to full discovery.
 */
export type ObservedSessionSourceListener = (signal?: ObservedSessionSourceSignal | string) => void;

/** How a source classifies one watch signal, resolved with at most one stat. */
export type ObservedSessionResolution =
  | { status: 'ignored' }
  | { status: 'unknown' }
  | { status: 'missing'; sessionId: string }
  | { status: 'present'; reference: ObservedSessionReference };

export interface ObservedSessionSourceSubscribeOptions {
  pollIntervalMs?: number;
}

export interface ObservedSessionCollectionSource<T = unknown> {
  providerId: string;
  discover(
    options?: ObservedSessionDiscoverOptions,
  ): Promise<ObservedSessionReference[]> | ObservedSessionReference[];
  read(reference: ObservedSessionReference): Promise<T> | T;
  refreshCached?(reference: ObservedSessionReference, value: T, observedAt: string): Promise<T> | T;
  /** Low-level invalidation signal; the collector performs fingerprint reconciliation. */
  subscribe?(
    listener: ObservedSessionSourceListener,
    options?: ObservedSessionSourceSubscribeOptions,
  ): { dispose(): void };
  /**
   * Map one watch signal to one session. Absent, or when the signal has no
   * filename, the collector falls back to full discovery.
   */
  resolveReference?(
    signal: ObservedSessionSourceSignal,
  ): Promise<ObservedSessionResolution> | ObservedSessionResolution;
  dispose?(): void;
}

export interface ProviderObservedSessionCollectionSource extends ObservedSessionCollectionSource<ObservedAgentSessionV1> {
  capabilities: ProviderCapabilitiesV1;
}

export type ObservedSessionDiagnosticKind =
  | 'provider-discovery-failed'
  | 'provider-discovery-completed'
  | 'session-read-failed'
  | 'provider-recovered'
  | 'session-recovered';

export type ObservedSessionDiagnosticSeverity = 'info' | 'warning' | 'error';
export type ObservedSessionDiagnosticPhase = 'discover' | 'read' | 'recover';
export type ObservedSessionDiscoveryTrigger = 'event' | 'poll' | 'initial' | 'collect';

/** Content-safe diagnostics: identifiers, retry metadata, and discovery cost only. */
export interface ObservedSessionDiagnostic {
  kind: ObservedSessionDiagnosticKind;
  severity: ObservedSessionDiagnosticSeverity;
  phase: ObservedSessionDiagnosticPhase;
  providerId: string;
  sessionId?: string;
  attempt?: number;
  retryAt?: number;
  /** `provider-discovery-completed` only: what started the discovery. */
  trigger?: ObservedSessionDiscoveryTrigger;
  durationMs?: number;
  referenceCount?: number;
  directoriesListed?: number;
  directoriesStatted?: number;
  filesStatted?: number;
  /** True when `limit` or `since` bounded the discovery. */
  partial?: boolean;
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
  /**
   * Ceiling on the wait between two full discoveries of one provider
   * (default 2 s). The wait actually applied is the smaller of this and four
   * times the previous discovery's duration, so cheap sources stay prompt.
   */
  minReconcileGapMs?: number;
  /** Parse-cache bound by entry count (default 20 000), least-recently-observed first. */
  maxCacheEntries?: number;
  /** Parse-cache bound by approximate bytes (default 128 MiB). */
  maxCacheBytes?: number;
  /** Size estimate per cached value; defaults to the JSON length, computed once per parse. */
  approximateValueBytes?: (value: T) => number;
}

/** Bounds for one `collect()`; a bounded pass never evicts sessions outside it. */
export interface ObservedSessionCollectOptions {
  limit?: number;
  since?: number;
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
  /** Overrides the collector's `minReconcileGapMs` for this subscription. */
  minReconcileGapMs?: number;
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
  bytes: number;
  passId: number;
}

interface KnownFingerprint {
  fingerprint: string;
  parts: ObservedSessionFingerprintParts | null;
}

interface DiscoverySnapshot {
  references: Map<string, ObservedSessionReference>;
  reuseUntil: number;
}

interface ScopedReference {
  /** Null records a removal. */
  reference: ObservedSessionReference | null;
  generation: number;
}

const DEFAULT_MAX_CONCURRENT_READS = 4;
const MAX_CONCURRENT_READS = 16;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MIN_RECONCILE_GAP_MS = 2_000;
const DEFAULT_MAX_CACHE_ENTRIES = 20_000;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;
const FALLBACK_VALUE_BYTES = 1_024;
/** A full discovery may recur once it has been idle this many times its own duration. */
const GAP_COST_MULTIPLIER = 4;

/**
 * Fail-soft observed-session collection with fingerprint-keyed parse caching,
 * cooperative reads, and optional provider-level subscriptions.
 */
export class ObservedSessionCollector<T = unknown> {
  private readonly failures = new Map<string, FailureState>();
  private readonly cache: BoundedCache<T>;
  private readonly subscriptions = new Set<{ dispose(): void }>();
  /** Latest complete reference set per provider, kept current by scoped reconciles. */
  private readonly lastDiscovery = new Map<string, DiscoverySnapshot>();
  /** One full discovery per provider at a time; concurrent callers share it. */
  private readonly inflightDiscovery = new Map<string, Promise<ObservedSessionReference[]>>();
  private readonly fullPassState = new Map<string, { endedAt: number; durationMs: number }>();
  /** Scoped results newer than an in-flight walk, so the walk cannot undo them. */
  private readonly scopedReferences = new Map<string, ScopedReference>();
  private generation = 0;
  private passId = 0;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: { now(): number };
  private readonly maxConcurrentReads: number;
  private readonly minReconcileGapMs: number;
  private readonly yieldBetweenReads: () => Promise<void>;

  constructor(private readonly options: ObservedSessionCollectorOptions<T>) {
    this.initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 30_000);
    this.maxBackoffMs = Math.max(this.initialBackoffMs, options.maxBackoffMs ?? 5 * 60_000);
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxConcurrentReads = Math.min(
      MAX_CONCURRENT_READS,
      Math.max(1, Math.floor(options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS)),
    );
    this.minReconcileGapMs = Math.max(0, options.minReconcileGapMs ?? DEFAULT_MIN_RECONCILE_GAP_MS);
    const estimate = options.approximateValueBytes ?? defaultValueBytes;
    this.cache = new BoundedCache<T>(
      Math.max(1, Math.floor(options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES)),
      Math.max(1, Math.floor(options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES)),
      (value) => {
        try {
          const bytes = estimate(value);
          return Number.isFinite(bytes) && bytes >= 0 ? bytes : FALLBACK_VALUE_BYTES;
        } catch {
          return FALLBACK_VALUE_BYTES;
        }
      },
    );
    this.yieldBetweenReads = async () => {
      if (options.yieldBetweenReads) {
        await options.yieldBetweenReads();
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
  }

  async collect(
    options: ObservedSessionCollectOptions = {},
  ): Promise<ObservedSessionCollection<T>[]> {
    this.passId++;
    const nested = await Promise.all(
      this.options.sources.map((source) => this.collectSource(source, options)),
    );
    return nested.flat();
  }

  /** Number of parsed sessions currently cached. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Subscribe to debounced provider changes. The listener receives fingerprints
   * only; call collect() to consume changed sessions through the parse cache.
   *
   * A signal that names a file is reconciled with one stat. Signals without a
   * filename, catch-up polls, and the initial pass run a full discovery, at
   * most once per gap per provider; bursts inside the debounce window join a
   * single trailing pass.
   */
  subscribe(
    listener: (batch: ObservedSessionChangeBatch) => void,
    options: ObservedSessionSubscribeOptions = {},
  ): { dispose(): void } {
    type Source = ObservedSessionCollectionSource<T>;
    const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const gapCeilingMs = Math.max(0, options.minReconcileGapMs ?? this.minReconcileGapMs);
    const known = new Map<string, KnownFingerprint>();
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerFireAt = 0;
    let running = false;
    let pendingScoped = new Map<string, { source: Source; signal: ObservedSessionSourceSignal }>();
    let pendingFull = new Map<Source, ObservedSessionDiscoveryTrigger>();
    const sourceDisposables: Array<{ dispose(): void }> = [];

    const gapRemainingMs = (source: Source, trigger: ObservedSessionDiscoveryTrigger): number => {
      if (trigger === 'initial') return 0;
      const state = this.fullPassState.get(source.providerId);
      if (!state) return 0;
      return Math.max(
        0,
        state.endedAt + this.effectiveGapMs(source.providerId, gapCeilingMs) - Date.now(),
      );
    };

    const emit = (batch: ObservedSessionChangeBatch): void => {
      if (batch.changes.length === 0) return;
      try {
        listener(batch);
      } catch {
        // Subscriber failures cannot stop reconciliation.
      }
    };

    // Arms the trailing timer; a later request can only pull it earlier,
    // never push it out, so a busy live session cannot starve the pass.
    const arm = (delayMs: number): void => {
      if (disposed) return;
      const fireAt = Date.now() + delayMs;
      if (timer && timerFireAt <= fireAt) return;
      if (timer) clearTimeout(timer);
      timerFireAt = fireAt;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
      timer.unref?.();
    };

    const requestFull = (source: Source, trigger: ObservedSessionDiscoveryTrigger): void => {
      const existing = pendingFull.get(source);
      if (!existing || existing === 'event') pendingFull.set(source, trigger);
    };

    const onSignal = (source: Source, signal?: ObservedSessionSourceSignal | string): void => {
      if (disposed) return;
      const parsed = typeof signal === 'object' && signal !== null ? signal : undefined;
      if (
        parsed &&
        typeof parsed.filename === 'string' &&
        parsed.filename.length > 0 &&
        source.resolveReference
      ) {
        pendingScoped.set(`${source.providerId}\0${parsed.root ?? ''}\0${parsed.filename}`, {
          source,
          signal: parsed,
        });
        arm(debounceMs);
        return;
      }
      const trigger: ObservedSessionDiscoveryTrigger =
        parsed?.trigger === 'poll' ? 'poll' : 'event';
      requestFull(source, trigger);
      arm(Math.max(debounceMs, gapRemainingMs(source, trigger)));
    };

    const run = async (): Promise<void> => {
      if (disposed || running) return;
      running = true;
      // Swap before the first await so signals landing mid-run are kept.
      const scoped = pendingScoped;
      pendingScoped = new Map();
      const full = pendingFull;
      pendingFull = new Map();
      try {
        const scopedChanges = new Map<Source, ObservedSessionChange[]>();
        for (const { source, signal } of scoped.values()) {
          if (disposed) return;
          const result = await this.reconcileSignal(source, signal, known, gapCeilingMs);
          if (disposed) return;
          if (result === 'unknown') {
            requestFull(source, 'event');
            continue;
          }
          if (!result) continue;
          const list = scopedChanges.get(source) ?? [];
          list.push(result);
          scopedChanges.set(source, list);
        }
        for (const [source, changes] of scopedChanges) {
          emit({
            providerId: source.providerId,
            changes,
            observedAt: new Date(this.clock.now()).toISOString(),
          });
        }

        for (const [source, trigger] of full) {
          if (disposed) return;
          if (gapRemainingMs(source, trigger) > 0) {
            requestFull(source, trigger);
            continue;
          }
          const batch = await this.reconcileSource(source, known, trigger, gapCeilingMs);
          // Re-check after the await: disposal during the reconcile must
          // not deliver the pre-disposal batch to the listener.
          if (disposed) return;
          if (batch) emit(batch);
        }
      } finally {
        running = false;
        if (!disposed && (pendingScoped.size > 0 || pendingFull.size > 0)) {
          let delayMs = pendingScoped.size > 0 ? debounceMs : Infinity;
          for (const [source, trigger] of pendingFull) {
            delayMs = Math.min(delayMs, Math.max(debounceMs, gapRemainingMs(source, trigger)));
          }
          arm(delayMs);
        }
      }
    };

    let needsCollectorPoll = false;
    for (const source of this.options.sources) {
      if (source.subscribe) {
        try {
          sourceDisposables.push(
            source.subscribe((signal) => onSignal(source, signal), { pollIntervalMs }),
          );
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
      pollTimer = setInterval(() => {
        for (const source of this.options.sources) onSignal(source, { trigger: 'poll' });
      }, pollIntervalMs);
      pollTimer.unref?.();
    }

    for (const source of this.options.sources) requestFull(source, 'initial');
    arm(debounceMs);
    const disposable = {
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        if (timer) clearTimeout(timer);
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
    this.lastDiscovery.clear();
    this.scopedReferences.clear();
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
    options: ObservedSessionCollectOptions,
  ): Promise<ObservedSessionCollection<T>[]> {
    const discoveryKey = `${source.providerId}\0$discovery`;
    const discoveryFailure = this.failures.get(discoveryKey);
    if (discoveryFailure && this.clock.now() < discoveryFailure.retryAt) return [];
    const partial = options.limit !== undefined || options.since !== undefined;
    let references: ObservedSessionReference[];
    // A reconcile pass within the gap already produced the references; a
    // collect() issued from the listener must not walk the provider again.
    const snapshot =
      !partial && this.subscriptions.size > 0
        ? this.lastDiscovery.get(source.providerId)
        : undefined;
    if (snapshot && Date.now() < snapshot.reuseUntil) {
      references = [...snapshot.references.values()];
    } else {
      try {
        references = await this.runDiscovery(source, 'collect', options);
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
    }

    if (!partial) {
      const activeKeys = new Set(
        references.map((ref) => this.key(source.providerId, ref.sessionId)),
      );
      this.evictMissing(source.providerId, activeKeys);
    }

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
    const cached = fingerprint.value === null ? undefined : this.cache.get(key, this.passId);
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
      this.cache.set(
        key,
        {
          value,
          fingerprint: fingerprint.value,
          fingerprintParts: fingerprint.parts,
          contentObservedAt,
        },
        this.passId,
      );
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

  /**
   * Runs `discover()` once per provider at a time. Unbounded discoveries are
   * shared with concurrent callers and update the gap bookkeeping; every
   * discovery emits one payload-free cost diagnostic.
   */
  private runDiscovery(
    source: ObservedSessionCollectionSource<T>,
    trigger: ObservedSessionDiscoveryTrigger,
    options: ObservedSessionCollectOptions = {},
  ): Promise<ObservedSessionReference[]> {
    const providerId = source.providerId;
    const partial = options.limit !== undefined || options.since !== undefined;
    if (!partial) {
      const inflight = this.inflightDiscovery.get(providerId);
      if (inflight) return inflight;
    }
    const stats: ObservedSessionDiscoveryStats = {};
    const startedAt = Date.now();
    const promise = (async () => {
      const references = await source.discover({
        limit: options.limit,
        since: options.since,
        stats,
      });
      const endedAt = Date.now();
      const durationMs = endedAt - startedAt;
      if (!partial) this.fullPassState.set(providerId, { endedAt, durationMs });
      this.emitDiagnostic(
        compact({
          kind: 'provider-discovery-completed',
          severity: 'info',
          phase: 'discover',
          providerId,
          trigger,
          durationMs,
          referenceCount: references.length,
          directoriesListed: stats.directoriesListed,
          directoriesStatted: stats.directoriesStatted,
          filesStatted: stats.filesStatted,
          partial: partial ? true : undefined,
        }),
      );
      return references;
    })();
    if (!partial) {
      this.inflightDiscovery.set(providerId, promise);
      const settle = (): void => {
        if (this.inflightDiscovery.get(providerId) === promise) {
          this.inflightDiscovery.delete(providerId);
        }
      };
      promise.then(settle, settle);
    }
    return promise;
  }

  private effectiveGapMs(providerId: string, ceilingMs: number): number {
    const state = this.fullPassState.get(providerId);
    if (!state) return 0;
    return Math.min(ceilingMs, state.durationMs * GAP_COST_MULTIPLIER);
  }

  /** Reconcile one watch signal against `known` with at most one stat. */
  private async reconcileSignal(
    source: ObservedSessionCollectionSource<T>,
    signal: ObservedSessionSourceSignal,
    known: Map<string, KnownFingerprint>,
    gapCeilingMs: number,
  ): Promise<ObservedSessionChange | null | 'unknown'> {
    if (!source.resolveReference) return 'unknown';
    let resolution: ObservedSessionResolution;
    try {
      resolution = await source.resolveReference(signal);
    } catch {
      return 'unknown';
    }
    if (!resolution || typeof resolution !== 'object') return 'unknown';
    const providerId = source.providerId;
    switch (resolution.status) {
      case 'ignored':
        return null;
      case 'missing': {
        const key = this.key(providerId, resolution.sessionId);
        this.scopedReferences.set(key, { reference: null, generation: ++this.generation });
        this.lastDiscovery.get(providerId)?.references.delete(resolution.sessionId);
        const previous = known.get(key);
        if (!previous) return null;
        known.delete(key);
        return {
          type: 'removed',
          reference: { sessionId: resolution.sessionId },
          previousFingerprint: previous.fingerprint,
          previousFingerprintParts: previous.parts,
          fingerprint: null,
          fingerprintParts: null,
        };
      }
      case 'present': {
        const reference = resolution.reference;
        const key = this.key(providerId, reference.sessionId);
        const current = await this.fingerprint(source, reference);
        if (current.value === null) return null;
        this.scopedReferences.set(key, { reference, generation: ++this.generation });
        const snapshot = this.lastDiscovery.get(providerId);
        if (snapshot) {
          snapshot.references.set(reference.sessionId, reference);
          snapshot.reuseUntil = Date.now() + this.effectiveGapMs(providerId, gapCeilingMs);
        }
        const previous = known.get(key);
        known.set(key, { fingerprint: current.value, parts: current.parts });
        if (previous && previous.fingerprint === current.value) return null;
        return {
          type: previous ? 'changed' : 'added',
          reference,
          previousFingerprint: previous?.fingerprint ?? null,
          previousFingerprintParts: previous?.parts ?? null,
          fingerprint: current.value,
          fingerprintParts: current.parts,
        };
      }
      default:
        return 'unknown';
    }
  }

  private async reconcileSource(
    source: ObservedSessionCollectionSource<T>,
    known: Map<string, KnownFingerprint>,
    trigger: ObservedSessionDiscoveryTrigger,
    gapCeilingMs: number,
  ): Promise<ObservedSessionChangeBatch | null> {
    const providerId = source.providerId;
    const prefix = `${providerId}\0`;
    const startGeneration = this.generation;
    let references: ObservedSessionReference[];
    try {
      references = await this.runDiscovery(source, trigger);
    } catch {
      return null;
    }
    const changes: ObservedSessionChange[] = [];
    const seen = new Set<string>();
    const snapshotReferences = new Map<string, ObservedSessionReference>();
    for (const discovered of references) {
      const key = this.key(providerId, discovered.sessionId);
      seen.add(key);
      // A scoped result that landed while the walk was running is newer than
      // the walk's copy; use it so the walk cannot flip the fingerprint back.
      const scoped = this.scopedReferences.get(key);
      const newer = scoped !== undefined && scoped.generation > startGeneration;
      if (newer && scoped.reference === null) continue;
      const reference = newer && scoped.reference ? scoped.reference : discovered;
      const current = await this.fingerprint(source, reference);
      if (current.value === null) continue;
      snapshotReferences.set(reference.sessionId, reference);
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
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      const scoped = this.scopedReferences.get(key);
      if (scoped && scoped.generation > startGeneration && scoped.reference) {
        // Created after the walk began; the scoped pass already reported it.
        snapshotReferences.set(scoped.reference.sessionId, scoped.reference);
        continue;
      }
      const sessionId = key.slice(prefix.length);
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
    for (const [key, entry] of this.scopedReferences) {
      if (key.startsWith(prefix) && entry.generation <= startGeneration) {
        this.scopedReferences.delete(key);
      }
    }
    this.lastDiscovery.set(providerId, {
      references: snapshotReferences,
      reuseUntil: Date.now() + this.effectiveGapMs(providerId, gapCeilingMs),
    });
    return {
      providerId,
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
    for (const key of [...this.cache.keys()]) {
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
 * Parse cache bounded by entry count and approximate bytes. Insertion order
 * doubles as recency: a hit re-inserts, so the first entry is always the
 * least recently observed. Entries observed in the current pass are never
 * evicted by that pass, so one oversized pass cannot thrash itself.
 */
class BoundedCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly estimate: (value: T) => number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, passId: number): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.passId = passId;
    return entry;
  }

  set(key: string, entry: Omit<CacheEntry<T>, 'bytes' | 'passId'>, passId: number): void {
    this.delete(key);
    const bytes = this.estimate(entry.value);
    this.entries.set(key, { ...entry, bytes, passId });
    this.totalBytes += bytes;
    this.evict(passId);
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  [Symbol.iterator](): IterableIterator<[string, CacheEntry<T>]> {
    return this.entries.entries();
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evict(passId: number): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      // Untouched entries always precede entries touched in this pass, so
      // a protected first entry means every remaining entry is protected.
      const first = this.entries.entries().next();
      if (first.done || first.value[1].passId === passId) return;
      this.delete(first.value[0]);
    }
  }
}

function defaultValueBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json.length : FALLBACK_VALUE_BYTES;
}

function compact(diagnostic: ObservedSessionDiagnostic): ObservedSessionDiagnostic {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diagnostic)) {
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as ObservedSessionDiagnostic;
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
  const referenceFromInfo = (info: {
    path: string;
    mtime: Date;
    sizeBytes?: number;
    sessionId?: string;
  }): ObservedSessionReference => {
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
  };
  const discover = async (
    discoverOptions: ObservedSessionDiscoverOptions = {},
  ): Promise<ObservedSessionReference[]> => {
    if (provider.listSessionFilesAsync) {
      try {
        const files = await provider.listSessionFilesAsync(cwd, {
          limit: discoverOptions.limit,
          since: discoverOptions.since,
          stats: discoverOptions.stats,
          // Appends do not bump a directory's mtime; a full pass re-checks
          // files modified recently so a missed watch event cannot hide a
          // live session's growth from a cached listing.
          revalidateRecent: true,
        });
        return files.map(referenceFromInfo);
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

  const source: ProviderObservedSessionCollectionSource = {
    providerId: provider.id,
    capabilities: adapter.capabilities,
    discover,
    async read(reference) {
      if (!reference.sourceKey) throw new Error('session source unavailable');
      return adapter.read(reference.sourceKey, cwd);
    },
    refreshCached(reference, cached, observedAt) {
      const mtimeMs = reference.fingerprintParts?.mtimeMs ?? Date.parse(cached.observedAt);
      const activity = refreshSessionActivityState(
        cached.activity.value,
        mtimeMs,
        Date.now(),
        getObservedActivityReason(cached),
      );
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
  if (provider.statWatchedSessionFile) {
    const statWatchedSessionFile = provider.statWatchedSessionFile.bind(provider);
    source.resolveReference = async (signal): Promise<ObservedSessionResolution> => {
      if (!signal.root || typeof signal.filename !== 'string' || signal.filename.length === 0) {
        return { status: 'unknown' };
      }
      const resolved: WatchedSessionFile = await statWatchedSessionFile(
        signal.root,
        signal.filename,
        cwd || undefined,
      );
      switch (resolved.status) {
        case 'present':
          return { status: 'present', reference: referenceFromInfo(resolved.file) };
        case 'missing':
          return { status: 'missing', sessionId: resolved.sessionId };
        case 'ignored':
          return { status: 'ignored' };
        default:
          return { status: 'unknown' };
      }
    };
  }
  return source;
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
  listener: ObservedSessionSourceListener,
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
      const watcher = fs.watch(
        root,
        { persistent: false, recursive: true },
        (eventType, filename) =>
          listener({
            trigger: 'event',
            root,
            eventType,
            filename: filename === null || filename === undefined ? null : String(filename),
          }),
      );
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
    pollTimer = setInterval(() => listener({ trigger: 'poll' }), pollIntervalMs);
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
