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
import * as os from 'os';
import { log, logError } from './Logger';

/** Minimum shape every persisted store must satisfy. */
export interface BaseStore {
  schemaVersion: number;
  lastSaved: string;
}

/** Save debounce delay shared by all persistence services (5 seconds). */
const SAVE_DEBOUNCE_MS = 5000;

let _sidekickBase: string | undefined;
function getSidekickBase(): string {
  if (!_sidekickBase) {
    _sidekickBase = process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'sidekick')
      : path.join(os.homedir(), '.config', 'sidekick');
  }
  return _sidekickBase;
}

/**
 * Resolves a path under the Sidekick config directory.
 *
 * - Linux/Mac: `~/.config/sidekick/{subdirectory}/{filename}`
 * - Windows:   `%APPDATA%/sidekick/{subdirectory}/{filename}`
 */
export function resolveSidekickDataPath(subdirectory: string, filename: string): string {
  const base = getSidekickBase();
  return subdirectory
    ? path.join(base, subdirectory, filename)
    : path.join(base, filename);
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
  private saveTimer: NodeJS.Timeout | null = null;

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
        log(`${this.logLabel} schema version mismatch: ${loaded.schemaVersion} vs ${this._schemaVersion}`);
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

  /** Marks the store as dirty and schedules a debounced save. */
  protected markDirty(): void {
    this.isDirty = true;
    this.scheduleSave();
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
    if (!this.isDirty) return;

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
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

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log(`${this.logLabel} data saved on dispose`);
      } catch (error) {
        logError(`Failed to save ${this.logLabel} data on dispose`, error);
      }
    }
  }
}
