/**
 * Append-only JSONL history of quota samples, scoped per workspace and per runtime provider.
 *
 * Sibling to `quotaSnapshots.ts`. Where snapshots persist a single most-recent sample per
 * (provider, account), this module accumulates time-series samples so consumers (the VS Code
 * dashboard, the `sidekick quota history` CLI, contextful_desktop) can render heatmaps and
 * trend visualisations over a 13-week window.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';
import type { QuotaState } from './quota';
import { writeQuotaSnapshot } from './quotaSnapshots';

export type QuotaHistoryRuntimeProvider = 'claude' | 'codex' | 'zai';

export interface QuotaHistorySample {
  timestamp: string;
  runtimeProvider: QuotaHistoryRuntimeProvider;
  providerId: string;
  workspaceId: string;
  fiveHour: { utilization: number; resetsAt: string };
  sevenDay: { utilization: number; resetsAt: string };
  available: boolean;
  error?: string;
  source?: 'session' | 'cache' | 'api';
  stale?: boolean;
}

export interface QuotaHistoryAppendOptions {
  /** Drop the sample if the most recent in-store sample is younger than this many ms. Default: 60_000. */
  minIntervalMs?: number;
  /** Retention window in days. Default: 91 (13 weeks). */
  retentionDays?: number;
}

export interface QuotaHistoryRangeOptions {
  workspaceId: string;
  provider: QuotaHistoryRuntimeProvider;
  /** Inclusive ISO start. Default: 13 weeks ago. */
  from?: string;
  /** Inclusive ISO end. Default: now. */
  to?: string;
}

export interface QuotaHistoryDailyBucket {
  date: string;
  samples: number;
  maxUtilizationFiveHour: number;
  maxUtilizationSevenDay: number;
  avgUtilizationFiveHour: number;
  avgUtilizationSevenDay: number;
  anyUnavailable: boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 91;
const PRUNE_FILESIZE_THRESHOLD = 16 * 1024;
const MS_PER_DAY = 86_400_000;

/** Per-file append serialization across in-process callers. */
const appendChains = new Map<string, Promise<void>>();
/** Per-file last-write timestamp cache, used for the debounce check. */
const lastWriteCache = new Map<string, number>();

/**
 * Stable, opaque workspace identifier — first 16 hex chars of sha256(realpath).
 * Shared between the VS Code extension (workspace folder fsPath) and the CLI (process.cwd()).
 */
export function getWorkspaceIdFromPath(workspacePath: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(workspacePath);
  } catch {
    resolved = path.resolve(workspacePath);
  }
  return crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

function getHistoryFilePath(workspaceId: string, provider: QuotaHistoryRuntimeProvider): string {
  return path.join(getConfigDir(), 'quota-history', workspaceId, `${provider}.jsonl`);
}

function ensureHistoryDir(workspaceId: string): void {
  fs.mkdirSync(path.join(getConfigDir(), 'quota-history', workspaceId), {
    recursive: true,
    mode: 0o700,
  });
}

function parseSampleLine(line: string): QuotaHistorySample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.timestamp === 'string' &&
      parsed.fiveHour &&
      parsed.sevenDay
    ) {
      return parsed as QuotaHistorySample;
    }
    return null;
  } catch {
    return null;
  }
}

function readLastSampleTimestampMs(filePath: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return null;
    const chunkSize = 4096;
    let remaining = stat.size;
    let buffer = Buffer.alloc(0);
    while (remaining > 0) {
      const readSize = Math.min(chunkSize, remaining);
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, remaining - readSize);
      buffer = Buffer.concat([chunk, buffer]);
      remaining -= readSize;
      const text = buffer.toString('utf8');
      // Look for the last newline that's not at end-of-text — that's the boundary of the final record.
      const trimmedRight = text.replace(/\n+$/, '');
      const lastNewline = trimmedRight.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const lastLine = trimmedRight.slice(lastNewline + 1);
        const sample = parseSampleLine(lastLine);
        return sample ? Date.parse(sample.timestamp) || null : null;
      }
      if (remaining === 0) {
        const sample = parseSampleLine(trimmedRight);
        return sample ? Date.parse(sample.timestamp) || null : null;
      }
    }
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

function atomicRewriteFile(filePath: string, contents: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
}

function pruneFileSync(filePath: string, retentionDays: number): { kept: number; pruned: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { kept: 0, pruned: 0 };
  }
  if (stat.size === 0) return { kept: 0, pruned: 0 };

  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const keptLines: string[] = [];
  let pruned = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const sample = parseSampleLine(line);
    if (!sample) {
      // Drop malformed lines during prune so the file self-heals.
      pruned += 1;
      continue;
    }
    const ts = Date.parse(sample.timestamp);
    if (Number.isFinite(ts) && ts >= cutoffMs) {
      keptLines.push(line);
    } else {
      pruned += 1;
    }
  }
  if (pruned > 0) {
    atomicRewriteFile(filePath, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '');
  }
  return { kept: keptLines.length, pruned };
}

function sampleToQuotaState(sample: QuotaHistorySample): QuotaState {
  const providerId = runtimeProviderToSnapshotProvider(sample.runtimeProvider);
  return {
    fiveHour: { utilization: sample.fiveHour.utilization, resetsAt: sample.fiveHour.resetsAt },
    sevenDay: { utilization: sample.sevenDay.utilization, resetsAt: sample.sevenDay.resetsAt },
    available: sample.available,
    error: sample.error,
    providerId,
    source: sample.source ?? 'session',
    capturedAt: sample.timestamp,
    stale: sample.stale,
  };
}

/**
 * Maps a runtime provider to the snapshot storage key.
 * `'zai'` is allowed at the storage layer even though it is not part of
 * `AccountProviderId` (z.ai has no full account management in v1).
 */
function runtimeProviderToSnapshotProvider(
  runtime: QuotaHistoryRuntimeProvider,
): 'claude-code' | 'codex' | 'zai' {
  if (runtime === 'claude') return 'claude-code';
  if (runtime === 'zai') return 'zai';
  return 'codex';
}

async function runAppend(
  sample: QuotaHistorySample,
  filePath: string,
  options: Required<QuotaHistoryAppendOptions>,
): Promise<void> {
  let lastTs = lastWriteCache.get(filePath);
  if (lastTs === undefined) {
    const fromDisk = readLastSampleTimestampMs(filePath);
    if (fromDisk !== null) {
      lastTs = fromDisk;
      lastWriteCache.set(filePath, fromDisk);
    }
  }

  const sampleTs = Date.parse(sample.timestamp);
  if (
    lastTs !== undefined &&
    Number.isFinite(sampleTs) &&
    sampleTs - lastTs < options.minIntervalMs
  ) {
    return;
  }

  ensureHistoryDir(sample.workspaceId);
  const line = JSON.stringify(sample) + '\n';
  await fs.promises.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
  lastWriteCache.set(filePath, Number.isFinite(sampleTs) ? sampleTs : Date.now());

  // Opportunistic prune. Skip when the file is small to avoid pointless rewrite churn.
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size >= PRUNE_FILESIZE_THRESHOLD) {
      pruneFileSync(filePath, options.retentionDays);
    }
  } catch {
    // ignore
  }

  // Backwards-compat: keep the latest-snapshot store hot so existing callers (DashboardViewProvider,
  // codex session provider, contextful_desktop) don't have to query history for "latest".
  try {
    const providerId = runtimeProviderToSnapshotProvider(sample.runtimeProvider);
    writeQuotaSnapshot(providerId, sample.providerId, sampleToQuotaState(sample));
  } catch {
    // Snapshot write failures must not poison the history append path.
  }
}

export async function appendQuotaHistorySample(
  sample: QuotaHistorySample,
  options: QuotaHistoryAppendOptions = {},
): Promise<void> {
  const resolved: Required<QuotaHistoryAppendOptions> = {
    minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
  };
  const filePath = getHistoryFilePath(sample.workspaceId, sample.runtimeProvider);

  const previous = appendChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(() => runAppend(sample, filePath, resolved))
    .catch(() => {
      // Swallow chain-level errors so a single failure doesn't break subsequent appends.
    });
  appendChains.set(filePath, next);
  try {
    await next;
  } finally {
    if (appendChains.get(filePath) === next) {
      appendChains.delete(filePath);
    }
  }
}

function defaultRangeMs(): { fromMs: number; toMs: number } {
  const toMs = Date.now();
  const fromMs = toMs - DEFAULT_RETENTION_DAYS * MS_PER_DAY;
  return { fromMs, toMs };
}

export async function readQuotaHistoryRange(
  options: QuotaHistoryRangeOptions,
): Promise<QuotaHistorySample[]> {
  const filePath = getHistoryFilePath(options.workspaceId, options.provider);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }

  const { fromMs: defaultFromMs, toMs: defaultToMs } = defaultRangeMs();
  const fromMs = options.from ? Date.parse(options.from) : defaultFromMs;
  const toMs = options.to ? Date.parse(options.to) : defaultToMs;

  const samples: QuotaHistorySample[] = [];
  for (const line of raw.split('\n')) {
    const sample = parseSampleLine(line);
    if (!sample) continue;
    const ts = Date.parse(sample.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts < fromMs || ts > toMs) continue;
    samples.push(sample);
  }
  samples.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return samples;
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysUtc(dateString: string, days: number): string {
  const ms = Date.parse(`${dateString}T00:00:00Z`) + days * MS_PER_DAY;
  return utcDateString(ms);
}

export async function readQuotaHistoryDailyBuckets(
  options: QuotaHistoryRangeOptions,
): Promise<QuotaHistoryDailyBucket[]> {
  const samples = await readQuotaHistoryRange(options);

  const { fromMs: defaultFromMs, toMs: defaultToMs } = defaultRangeMs();
  const fromMs = options.from ? Date.parse(options.from) : defaultFromMs;
  const toMs = options.to ? Date.parse(options.to) : defaultToMs;

  const startDate = utcDateString(fromMs);
  const endDate = utcDateString(toMs);

  const grouped = new Map<string, QuotaHistorySample[]>();
  for (const sample of samples) {
    const day = sample.timestamp.slice(0, 10);
    const bucket = grouped.get(day);
    if (bucket) {
      bucket.push(sample);
    } else {
      grouped.set(day, [sample]);
    }
  }

  const buckets: QuotaHistoryDailyBucket[] = [];
  let cursor = startDate;
  // Safety bound — 26 weeks worst case = 182 days; we cap iteration well above that.
  for (let i = 0; i <= 366 && cursor <= endDate; i += 1) {
    const daySamples = grouped.get(cursor);
    if (!daySamples || daySamples.length === 0) {
      buckets.push({
        date: cursor,
        samples: 0,
        maxUtilizationFiveHour: 0,
        maxUtilizationSevenDay: 0,
        avgUtilizationFiveHour: 0,
        avgUtilizationSevenDay: 0,
        anyUnavailable: false,
      });
    } else {
      let maxFive = 0;
      let maxSeven = 0;
      let sumFive = 0;
      let sumSeven = 0;
      let anyUnavailable = false;
      for (const s of daySamples) {
        maxFive = Math.max(maxFive, s.fiveHour.utilization);
        maxSeven = Math.max(maxSeven, s.sevenDay.utilization);
        sumFive += s.fiveHour.utilization;
        sumSeven += s.sevenDay.utilization;
        if (!s.available) anyUnavailable = true;
      }
      const n = daySamples.length;
      buckets.push({
        date: cursor,
        samples: n,
        maxUtilizationFiveHour: maxFive,
        maxUtilizationSevenDay: maxSeven,
        avgUtilizationFiveHour: Math.round((sumFive / n) * 100) / 100,
        avgUtilizationSevenDay: Math.round((sumSeven / n) * 100) / 100,
        anyUnavailable,
      });
    }
    cursor = addDaysUtc(cursor, 1);
  }
  return buckets;
}

export async function pruneQuotaHistory(
  workspaceId: string,
  provider: QuotaHistoryRuntimeProvider,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<{ kept: number; pruned: number }> {
  const filePath = getHistoryFilePath(workspaceId, provider);
  return pruneFileSync(filePath, retentionDays);
}

/** Test-only: wipe the in-memory mutex/debounce state. Not exported from index.ts. */
export function _resetQuotaHistoryInMemoryStateForTests(): void {
  appendChains.clear();
  lastWriteCache.clear();
}
