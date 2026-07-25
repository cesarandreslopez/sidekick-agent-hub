/**
 * Persisted record of context windows providers actually reported (Node-only).
 *
 * Some agents report the real context window for the running session — Codex
 * emits `model_context_window` on every `token_count` event. That number is the
 * *effective* window for the account and tier, which can sit well below the
 * model's published maximum (e.g. 258,400 observed for `gpt-5.6-sol` against a
 * catalog maximum of 1,050,000).
 *
 * A live session uses that value directly. This module keeps it across runs, so
 * historical and static views don't fall back to a published maximum that would
 * make the context gauge read far too empty.
 *
 * Precedence, most-trusted first: runtime → observed (here) → LiteLLM catalog →
 * static table. See `modelContext.ts`.
 *
 * @module observedContextWindows
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { _setObservedContextWindows, _getObservedContextWindows } from './modelContext';
import { getConfigDir } from './paths';
import { updateJsonStoreAtomic } from './writers/atomic';

// ── Types ──

export interface ObservedContextWindowOptions {
  /** Directory for the store (defaults to the Sidekick config dir). */
  cacheDir?: string;
  /** Optional logger (useful for diagnostics without pulling a logger dep). */
  logger?: (msg: string) => void;
}

export interface ObservedContextWindowEntry {
  contextWindow: number;
  /** ISO timestamp of the most recent observation. */
  observedAt: string;
}

export interface ObservedContextWindowStore {
  version: 1;
  models: Record<string, ObservedContextWindowEntry>;
}

// ── Constants ──

const STORE_FILE_NAME = 'observed-context-windows.json';
const STORE_VERSION = 1;

/** Resolve the on-disk store path. */
export function getObservedContextWindowPath(cacheDir?: string): string {
  return path.join(cacheDir ?? getConfigDir(), STORE_FILE_NAME);
}

function emptyStore(): ObservedContextWindowStore {
  return { version: STORE_VERSION, models: {} };
}

/**
 * Last value successfully persisted, per resolved store path.
 *
 * The in-memory override table in `modelContext` is process-global by design —
 * a lookup should answer the same way everywhere. That makes it unusable as the
 * write dedupe: with two `cacheDir`s in one process (two temp dirs in a test
 * suite, a multi-tenant host, a CLI and extension host sharing a process), the
 * global would already hold the value from the first store and the second store
 * would never be written at all.
 */
const lastPersistedByStore = new Map<string, Map<string, number>>();

/** Reset the per-store write dedupe. Test-only; not part of the public API. */
export function _clearObservedContextWindowWriteCache(): void {
  lastPersistedByStore.clear();
}

/** Keep only well-formed entries; a hand-edited or partly-corrupt file shouldn't poison lookups. */
function toOverrideMap(store: ObservedContextWindowStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [modelId, entry] of Object.entries(store.models ?? {})) {
    const window = entry?.contextWindow;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) continue;
    out[modelId] = window;
  }
  return out;
}

// ── Public API ──

/**
 * Load persisted observations and apply them as context-window overrides.
 *
 * Always resolves — never throws. A missing, unreadable, or malformed store
 * leaves the overrides empty and lookups fall through to catalog/static.
 */
export async function loadObservedContextWindows(
  options: ObservedContextWindowOptions = {},
): Promise<Record<string, number>> {
  const storePath = getObservedContextWindowPath(options.cacheDir);
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as ObservedContextWindowStore;
    if (!parsed || typeof parsed !== 'object' || !parsed.models) return {};

    const overrides = toOverrideMap(parsed);
    _setObservedContextWindows(overrides);
    return overrides;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      options.logger?.(`observedContextWindows: failed to load ${storePath}: ${String(err)}`);
    }
    return {};
  }
}

/**
 * Record a provider-reported context window for a model.
 *
 * Applies in memory immediately, then persists — but only when the value
 * actually changed *for that store*. Codex reports a window on every
 * `token_count` event, so an unconditional write would mean disk I/O many times
 * per session for a value that almost never moves.
 *
 * Always resolves — never throws. Persistence failures are logged and dropped;
 * the in-memory override still stands for this process, and the next call
 * retries the write.
 */
export async function recordObservedContextWindow(
  modelId: string,
  contextWindow: number,
  options: ObservedContextWindowOptions = {},
): Promise<void> {
  const normalizedId = modelId?.trim().toLowerCase();
  if (!normalizedId) return;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;

  const current = _getObservedContextWindows();
  if (current[normalizedId] !== contextWindow) {
    _setObservedContextWindows({ ...current, [normalizedId]: contextWindow });
  }

  const storePath = getObservedContextWindowPath(options.cacheDir);
  const persisted = lastPersistedByStore.get(storePath);
  if (persisted?.get(normalizedId) === contextWindow) return;

  try {
    // Lock-guarded read-modify-write: the CLI and the extension host can both
    // be observing sessions at once, and each should merge rather than clobber.
    await updateJsonStoreAtomic<ObservedContextWindowStore>(storePath, emptyStore, (latest) => {
      const models = latest?.models ?? {};
      if (models[normalizedId]?.contextWindow === contextWindow) return latest;
      return {
        version: STORE_VERSION,
        models: {
          ...models,
          [normalizedId]: { contextWindow, observedAt: new Date().toISOString() },
        },
      };
    });
    // Recorded only on success, so a transient EACCES retries next time.
    let store = lastPersistedByStore.get(storePath);
    if (!store) {
      store = new Map();
      lastPersistedByStore.set(storePath, store);
    }
    store.set(normalizedId, contextWindow);
  } catch (err) {
    options.logger?.(`observedContextWindows: failed to persist ${storePath}: ${String(err)}`);
  }
}
