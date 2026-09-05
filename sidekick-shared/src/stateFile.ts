/**
 * `state.json`: a small, versioned file for external consumers (tmux
 * status bars, menu-bar apps, scripts) that want Sidekick's current account,
 * quota windows with freshness, context usage, session cost, and the active
 * billing block without running a Sidekick command.
 *
 * Written by the status line on every prompt and by both dashboards on their
 * refresh ticks, but only when the content changed, so the hot path costs one
 * small read in the common case. The schema is public: `schemaVersion` is 1,
 * fields are only ever added, and the matching zod schema lives in
 * `sidekick-shared/schemas` (`sidekickStateFileSchema`). This module does not
 * import zod, so the status-line fast path stays small.
 *
 * @module stateFile
 */

import * as fs from 'fs';
import { getGlobalDataPath } from './paths';
import { classifyQuotaFreshness } from './quota';
import type { QuotaState } from './quota';
import type { BillingBlock } from './usage/billingBlocks';
import { atomicWriteJsonSync } from './writers/atomic';

export const STATE_FILE_SCHEMA_VERSION = 1;
export const STATE_FILE_NAME = 'state.json';

export type StateFileWriter = 'statusline' | 'cli-dashboard' | 'vscode-dashboard';

export interface StateFileQuotaWindow {
  /** Utilization percentage (0–100). */
  utilization: number;
  /** ISO timestamp when the window resets; empty when unknown. */
  resetsAt: string;
}

export interface StateFileQuota {
  fiveHour: StateFileQuotaWindow;
  sevenDay: StateFileQuotaWindow;
  /** How the sample was obtained (`cache` when read back from the snapshot store). */
  source: 'api' | 'session' | 'cache' | 'statusline' | null;
  /** Original origin of a cached sample. */
  capturedSource: 'api' | 'session' | 'statusline' | null;
  capturedAt: string | null;
  ageMs: number | null;
  freshness: 'fresh' | 'aging' | 'stale' | null;
}

export interface StateFileAccount {
  providerId: 'claude-code' | 'codex';
  /** Sidekick registry id used to key quota snapshots and history. */
  id: string | null;
  label: string | null;
}

export interface StateFileContext {
  usedPercentage: number | null;
  contextWindowSize: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
}

export interface StateFileSession {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Prompt-cache hit ratio (0–1) when the provider reports it. */
  promptCacheHitRatio: number | null;
}

export interface StateFileBillingBlock {
  start: string;
  end: string;
  isActive: boolean;
  /** Cache-inclusive tokens so far. */
  tokens: number;
  costUsd: number;
  costProvenance: 'reported' | 'estimated' | 'mixed' | 'unpriced' | 'none';
  burnRatePerMinute: number;
  projectedTokens: number;
  projectedCostUsd: number;
  remainingMs: number;
}

export interface SidekickStateFile {
  schemaVersion: typeof STATE_FILE_SCHEMA_VERSION;
  /** ISO timestamp of the write. Excluded from the unchanged comparison. */
  writtenAt: string;
  writer: StateFileWriter;
  account: StateFileAccount | null;
  quota: {
    claude: StateFileQuota | null;
    codex: StateFileQuota | null;
  };
  context: StateFileContext | null;
  session: StateFileSession | null;
  /** Active five-hour block (local estimate); null when unknown or not computed by the writer. */
  billingBlock: StateFileBillingBlock | null;
}

/** Everything but the fields the writer stamps itself. */
export type SidekickStateInput = Omit<SidekickStateFile, 'schemaVersion' | 'writtenAt'>;

export interface WriteStateFileOptions {
  /** Defaults to `<configDir>/state.json`. */
  filePath?: string;
  /** Clock for `writtenAt` (default `new Date()`). */
  now?: Date;
}

export function getStateFilePath(): string {
  return getGlobalDataPath(STATE_FILE_NAME);
}

/** Read the current state file; null when absent or unreadable. */
export function readStateFile(filePath: string = getStateFilePath()): SidekickStateFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SidekickStateFile;
    return parsed && parsed.schemaVersion === STATE_FILE_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** Key-order-independent serialisation, dropping undefined values. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The content that decides whether a rewrite is needed: everything the writer does not stamp. */
function comparable(state: SidekickStateInput | SidekickStateFile): string {
  return stableStringify({ ...state, schemaVersion: undefined, writtenAt: undefined });
}

/**
 * Write the state file atomically, but only when something other than
 * `writtenAt` changed since the last write. Returns true when a write
 * happened. Never throws: the state file is a convenience for other tools.
 */
export function writeStateFile(
  state: SidekickStateInput,
  options: WriteStateFileOptions = {},
): boolean {
  const filePath = options.filePath ?? getStateFilePath();
  try {
    const existing = readStateFile(filePath);
    if (existing && comparable(existing) === comparable(state)) return false;
    const next: SidekickStateFile = {
      schemaVersion: STATE_FILE_SCHEMA_VERSION,
      writtenAt: (options.now ?? new Date()).toISOString(),
      ...state,
    };
    atomicWriteJsonSync(filePath, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Project a quota sample onto the state-file shape. A live sample (for
 * example from the status-line payload) carries `capturedAt` but no age, so
 * the age and freshness are derived from `now` when the sample omits them.
 */
export function quotaToStateFile(
  quota: QuotaState | null | undefined,
  now: number = Date.now(),
): StateFileQuota | null {
  if (!quota || !quota.available) return null;
  let ageMs = typeof quota.ageMs === 'number' ? quota.ageMs : null;
  let freshness = quota.freshness ?? null;
  if (ageMs === null && quota.capturedAt) {
    const capturedMs = Date.parse(quota.capturedAt);
    if (Number.isFinite(capturedMs)) {
      ageMs = Math.max(0, now - capturedMs);
      freshness ??= classifyQuotaFreshness(ageMs);
    }
  }
  return {
    fiveHour: { utilization: quota.fiveHour.utilization, resetsAt: quota.fiveHour.resetsAt },
    sevenDay: { utilization: quota.sevenDay.utilization, resetsAt: quota.sevenDay.resetsAt },
    source: quota.source ?? null,
    capturedSource: quota.capturedSource ?? null,
    capturedAt: quota.capturedAt ?? null,
    ageMs,
    freshness,
  };
}

/** Project a billing block onto the state-file shape (totals only). */
export function billingBlockToStateFile(
  block: BillingBlock | null | undefined,
): StateFileBillingBlock | null {
  if (!block) return null;
  return {
    start: block.start,
    end: block.end,
    isActive: block.isActive,
    tokens: block.tokens.total,
    costUsd: block.costUsd,
    costProvenance: block.costProvenance,
    burnRatePerMinute: block.burnRatePerMinute,
    projectedTokens: block.projectedTokens,
    projectedCostUsd: block.projectedCostUsd,
    remainingMs: block.remainingMs,
  };
}
