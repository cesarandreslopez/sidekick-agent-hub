/**
 * @fileoverview Cross-session decision log persistence service.
 *
 * Persists extracted decisions to disk so they carry forward across
 * Claude Code sessions. Follows the TaskPersistenceService pattern:
 * dirty tracking, debounced saves, synchronous dispose.
 *
 * Storage location: ~/.config/sidekick/decisions/{projectSlug}.json
 *
 * @module services/DecisionLogService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  DecisionEntry,
  DecisionLogStore,
  DecisionEntryDisplay,
} from '../types/decisionLog';
import { DECISION_LOG_SCHEMA_VERSION } from '../types/decisionLog';
import { log, logError } from './Logger';

function createEmptyStore(): DecisionLogStore {
  return {
    schemaVersion: DECISION_LOG_SCHEMA_VERSION,
    decisions: {},
    lastSessionId: '',
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Service for persisting decisions across Claude Code sessions.
 */
export class DecisionLogService implements vscode.Disposable {
  private store: DecisionLogStore;
  private dataFilePath: string;
  private isDirty: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  constructor(private readonly projectSlug: string) {
    this.store = createEmptyStore();
    this.dataFilePath = this.getDataFilePath();
  }

  private getDataFilePath(): string {
    let configDir: string;

    if (process.platform === 'win32') {
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'decisions');
    } else {
      configDir = path.join(os.homedir(), '.config', 'sidekick', 'decisions');
    }

    return path.join(configDir, `${this.projectSlug}.json`);
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created decision log directory: ${dir}`);
      }

      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as DecisionLogStore;

        if (loaded.schemaVersion !== DECISION_LOG_SCHEMA_VERSION) {
          log(`Decision log schema version mismatch: ${loaded.schemaVersion} vs ${DECISION_LOG_SCHEMA_VERSION}`);
        }

        this.store = loaded;
        log(`Loaded persisted decisions: ${Object.keys(this.store.decisions).length} entries`);
      } else {
        this.store = createEmptyStore();
        log('Initialized new decision log store');
      }
    } catch (error) {
      logError('Failed to load persisted decisions, starting with empty store', error);
      this.store = createEmptyStore();
    }
  }

  /**
   * Adds new decision entries, deduplicating against existing ones.
   */
  addEntries(entries: DecisionEntry[]): void {
    const existingFingerprints = new Set(
      Object.values(this.store.decisions).map(
        d => `${d.source}::${d.description.toLowerCase().trim()}`
      )
    );

    let added = 0;
    for (const entry of entries) {
      const fp = `${entry.source}::${entry.description.toLowerCase().trim()}`;
      if (existingFingerprints.has(fp)) continue;

      this.store.decisions[entry.id] = entry;
      existingFingerprints.add(fp);
      added++;
    }

    if (added > 0) {
      this.isDirty = true;
      this.scheduleSave();
      log(`Added ${added} new decisions (${entries.length - added} duplicates skipped)`);
    }
  }

  /**
   * Returns decision entries for display, optionally filtered by search query.
   */
  getEntries(query?: string): DecisionEntryDisplay[] {
    let entries = Object.values(this.store.decisions);

    if (query && query.trim().length > 0) {
      const q = query.toLowerCase().trim();
      entries = entries.filter(
        d =>
          d.description.toLowerCase().includes(q) ||
          d.rationale.toLowerCase().includes(q) ||
          d.chosenOption.toLowerCase().includes(q)
      );
    }

    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return entries.map(d => ({
      id: d.id,
      description: d.description,
      rationale: d.rationale,
      chosenOption: d.chosenOption,
      source: d.source,
      timestamp: d.timestamp,
      alternatives: d.alternatives,
      tags: d.tags,
    }));
  }

  getEntryCount(): number {
    return Object.keys(this.store.decisions).length;
  }

  setLastSessionId(sessionId: string): void {
    this.store.lastSessionId = sessionId;
    this.isDirty = true;
    this.scheduleSave();
  }

  clearAll(): void {
    const count = Object.keys(this.store.decisions).length;
    this.store.decisions = {};
    if (count > 0) {
      this.isDirty = true;
      this.scheduleSave();
      log(`Cleared all ${count} decisions`);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (!this.isDirty) return;

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Decision log data saved to disk');
    } catch (error) {
      logError('Failed to save decision log data', error);
    }
  }

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
        log('Decision log data saved on dispose');
      } catch (error) {
        logError('Failed to save decision log data on dispose', error);
      }
    }
  }
}
