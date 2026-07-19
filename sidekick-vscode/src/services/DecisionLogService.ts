/**
 * @fileoverview Cross-session decision log persistence service.
 *
 * Persists extracted decisions to disk so they carry forward across
 * Claude Code sessions.
 *
 * Storage location: ~/.config/sidekick/decisions/{projectSlug}.json
 *
 * @module services/DecisionLogService
 */

import type { DecisionEntry, DecisionLogStore, DecisionEntryDisplay } from '../types/decisionLog';
import { DECISION_LOG_SCHEMA_VERSION } from '../types/decisionLog';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

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
export class DecisionLogService extends PersistenceService<DecisionLogStore> {
  constructor(projectSlug: string) {
    super(
      resolveSidekickDataPath('decisions', `${projectSlug}.json`),
      'Decision log',
      DECISION_LOG_SCHEMA_VERSION,
      createEmptyStore,
    );
  }

  protected override onStoreLoaded(): void {
    log(`Loaded persisted decisions: ${Object.keys(this.store.decisions).length} entries`);
  }

  protected override mergeStoreForSave(
    latest: DecisionLogStore,
    pending: DecisionLogStore,
  ): DecisionLogStore {
    const decisions = { ...latest.decisions, ...pending.decisions };
    for (const key of this.deletedKeys) delete decisions[key];
    return {
      ...latest,
      ...pending,
      decisions,
      schemaVersion: DECISION_LOG_SCHEMA_VERSION,
    };
  }

  /**
   * Adds new decision entries, deduplicating against existing ones.
   */
  addEntries(entries: DecisionEntry[]): void {
    const existingFingerprints = new Set(
      Object.values(this.store.decisions).map(
        (d) => `${d.source}::${d.description.toLowerCase().trim()}`,
      ),
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
      this.markDirty();
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
        (d) =>
          d.description.toLowerCase().includes(q) ||
          d.rationale.toLowerCase().includes(q) ||
          d.chosenOption.toLowerCase().includes(q),
      );
    }

    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return entries.map((d) => ({
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
    this.markDirty();
  }

  clearAll(): void {
    const keys = Object.keys(this.store.decisions);
    this.store.decisions = {};
    if (keys.length > 0) {
      this.recordDeletions(keys);
      this.markDirty();
      log(`Cleared all ${keys.length} decisions`);
    }
  }
}
