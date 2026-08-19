/**
 * @fileoverview Generic base class for JSON-file persistence services.
 *
 * Encapsulates the common boilerplate shared by DecisionLogService,
 * KnowledgeNoteService, TaskPersistenceService, HistoricalDataService,
 * PlanPersistenceService, and NotificationPersistenceService:
 *
 * - Platform-aware config-directory resolution
 * - Directory creation on first use
 * - Schema-version checking on load
 * - Dirty tracking with debounced async saves
 * - Synchronous save on dispose
 *
 * @module services/PersistenceService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from './Logger';
import { getConfigDir, updateJsonStoreAtomic, updateJsonStoreAtomicSync } from 'sidekick-shared';

/** Minimum shape every persisted store must satisfy. */
export interface BaseStore {
  schemaVersion: number;
  lastSaved: string;
}

/** Save debounce delay shared by all persistence services (5 seconds). */
const SAVE_DEBOUNCE_MS = 5000;

/**
 * Resolves a path under the Sidekick config directory.
 *
 * The base honors a `setConfigDir()` override and `SIDEKICK_CONFIG_DIR`,
 * falling back to `~/.config/sidekick` (`%APPDATA%/sidekick` on Windows) —
 * the same resolution the shared library's own stores use.
 */
export function resolveSidekickDataPath(subdirectory: string, filename: string): string {
  const base = getConfigDir();
  return subdirectory ? path.join(base, subdirectory, filename) : path.join(base, filename);
}

/**
 * Abstract base class for services that persist a typed JSON store to disk.
 *
 * Subclasses provide:
 * - `logLabel` — human-readable name for log messages
 * - `schemaVersion` — expected schema version for migration checks
 * - `createEmptyStore()` — factory for a fresh store instance
 * - `dataFilePath` — resolved via `resolveSidekickDataPath()` before calling `super()`
 *
 * The base class handles initialize/save/dispose lifecycle automatically.
 */
export abstract class PersistenceService<T extends BaseStore> implements vscode.Disposable {
  protected store: T;
  private isDirty = false;
  private mutationGeneration = 0;
  private saveInFlight: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingDeletions = new Set<string>();

  constructor(
    protected readonly dataFilePath: string,
    protected readonly logLabel: string,
    private readonly _schemaVersion: number,
    private readonly _createEmptyStore: () => T,
  ) {
    this.store = _createEmptyStore();
  }

  /**
   * Loads the store from disk, creating the directory and file if needed.
   * Safe to call multiple times — subsequent calls overwrite in-memory state.
   */
  async initialize(): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.dataFilePath), { recursive: true });
      const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
      const loaded = JSON.parse(content) as T;

      if (loaded.schemaVersion !== this._schemaVersion) {
        log(
          `${this.logLabel} schema version mismatch: ${loaded.schemaVersion} vs ${this._schemaVersion}`,
        );
      }

      this.store = loaded;
      this.onStoreLoaded();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.store = this._createEmptyStore();
        log(`Initialized new ${this.logLabel} store`);
      } else {
        logError(`Failed to load persisted ${this.logLabel}, starting with empty store`, error);
        this.store = this._createEmptyStore();
      }
    }
  }

  /**
   * Hook called after the store is successfully loaded from disk.
   * Override to perform post-load processing (e.g., recounting totals).
   */
  protected onStoreLoaded(): void {
    // Default: no-op
  }

  /** Merge fresh on-disk state before an atomic write. */
  protected mergeStoreForSave(_latest: T, pending: T): T {
    return pending;
  }

  /**
   * Reloads fresh on-disk state without discarding locally queued mutations.
   * File-watching subclasses use this to reconcile writes from the CLI.
   */
  protected async refreshFromDisk(): Promise<boolean> {
    try {
      const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
      const loaded = JSON.parse(content) as T;
      this.store = this.isDirty ? this.mergeStoreForSave(loaded, this.store) : loaded;
      this.onStoreLoaded();
      return true;
    } catch (error) {
      logError(`Failed to refresh persisted ${this.logLabel}`, error);
      return false;
    }
  }

  /** Marks the store as dirty and schedules a debounced save. */
  protected markDirty(): void {
    this.isDirty = true;
    this.mutationGeneration++;
    this.scheduleSave();
  }

  /**
   * Records store keys deleted locally since the last successful save.
   * mergeStoreForSave implementations subtract these so the union with
   * on-disk state cannot resurrect entries the user removed.
   */
  protected recordDeletions(keys: Iterable<string>): void {
    for (const key of keys) this.pendingDeletions.add(key);
  }

  /** Keys deleted locally that have not yet been flushed to disk. */
  protected get deletedKeys(): ReadonlySet<string> {
    return this.pendingDeletions;
  }

  /** Forces an immediate async save (useful during extension deactivation). */
  async forceSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (this.saveInFlight) {
      await this.saveInFlight;
      if (this.isDirty) await this.save();
      return;
    }
    if (!this.isDirty) return;

    this.saveInFlight = this.performSave();
    try {
      await this.saveInFlight;
    } finally {
      this.saveInFlight = null;
    }
  }

  private async performSave(): Promise<void> {
    try {
      const generation = this.mutationGeneration;
      this.store.lastSaved = new Date().toISOString();
      const pending = this.store;
      const saved = await updateJsonStoreAtomic(
        this.dataFilePath,
        this._createEmptyStore,
        (latest) => this.mergeStoreForSave(latest, pending),
      );
      if (generation === this.mutationGeneration) {
        this.store = saved;
        this.isDirty = false;
        this.pendingDeletions.clear();
      } else {
        // A mutation landed while the atomic write was awaiting its lock/I/O.
        // Reconcile the completed snapshot into the newer in-memory state and
        // leave it dirty for the next flush rather than overwriting it.
        this.store = this.mergeStoreForSave(saved, this.store);
        this.isDirty = true;
        this.scheduleSave();
      }
      log(`${this.logLabel} data saved to disk`);
    } catch (error) {
      logError(`Failed to save ${this.logLabel} data`, error);
    }
  }

  /** Disposes the service, synchronously flushing any unsaved data. */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.saveInFlight) {
      // The async save already holds (or is acquiring) this store's
      // cross-process lock. A sync flush here would park the event loop on
      // that same lock — which the parked loop can never release — freeze
      // the host until the lock timeout, and then skip the flush anyway.
      // Let the in-flight save land instead.
      return;
    }

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const pending = this.store;
        this.store = updateJsonStoreAtomicSync(
          this.dataFilePath,
          this._createEmptyStore,
          (latest) => this.mergeStoreForSave(latest, pending),
        );
        this.isDirty = false;
        this.pendingDeletions.clear();
        log(`${this.logLabel} data saved on dispose`);
      } catch (error) {
        // Includes a store-lock timeout: skipping the flush is preferable to
        // clobbering a concurrent CLI write.
        logError(`Failed to save ${this.logLabel} data on dispose`, error);
      }
    }
  }
}
