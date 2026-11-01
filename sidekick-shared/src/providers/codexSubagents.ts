/**
 * Codex subagent discovery for `CodexProvider.scanSubagents()`.
 *
 * Every spawned thread below a session (children, their children, …), each
 * with its rollout, the parent's spawn call that started it, its nickname and
 * agent path, and stats from the child's own records. A forked child's
 * rollout embeds the parent's session_meta and history before
 * `session_meta.subagent_history_start_ordinal`; that prefix is the parent's
 * and is not counted (the parser skips it, and so do the timestamps here).
 *
 * The spawn link comes from the parent's rollout: the `item_completed` →
 * `SubAgentActivity` record with `kind: 'started'` names the spawn call id
 * and the child thread. When a parent has no such record (older Codex), the
 * spawn call whose output named the child's agent path
 * (`{"task_name":"/root/x"}`) is used. Parent scans are cached and read
 * incrementally as the parent rollout grows.
 *
 * Node-only: reads files.
 *
 * @module providers/codexSubagents
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodexRolloutParser } from '../parsers/codexParser';
import { cachedSubagentStats } from '../parsers/subagentStatsCache';
import type { CodexDbThread, CodexRolloutLine, CodexSessionMeta } from '../types/codex';
import type { SessionEvent, SubagentStats } from '../types/sessionEvent';
import { extractNormalizedUsage } from '../usageNormalization';
import { addUsageToSubagent } from '../usage/subagentUsage';
import { codexSpawnParentFromSource as spawnParentFromSource } from '../parsers/codexRolloutOrigin';
import type { CodexDatabase } from './codexDatabase';
import { readSessionMeta } from './codexRollouts';
import {
  isCompressedRolloutPath,
  readRolloutBuffer,
  readRolloutText,
  resolveRolloutPath,
  type ReadRolloutOptions,
} from './compressedRollouts';
import { extractRolloutSessionId } from './rolloutWalker';
import type { RolloutFileInfo } from './rolloutWalker';

/** The spawn calls a rollout records, from its own (not inherited) records. */
export interface CodexSpawnLinks {
  /** Child thread id → the spawn call that started it (`SubAgentActivity` `started`). */
  started: Map<string, { callId: string; agentPath?: string }>;
  /** Agent path → the spawn calls whose output named it, in file order. */
  spawnedPaths: Map<string, string[]>;
}

interface SpawnLinkEntry {
  size: number;
  mtimeMs: number;
  /** Bytes consumed (after the last complete line); plain rollouts only. */
  offset: number;
  /** The own session_meta's history start; `undefined` until it is seen. */
  historyStart: number | null | undefined;
  /** Set once an embedded ancestor session_meta shows the rollout is a fork. */
  skipBelow: number | null;
  /** Spawn calls still waiting for their output. */
  pendingSpawns: Set<string>;
  links: CodexSpawnLinks;
}

const SPAWN_LINK_CACHE_LIMIT = 256;
const PENDING_SPAWN_LIMIT = 1024;
const spawnLinkCache = new Map<string, SpawnLinkEntry>();

/** @internal Test hook. */
export function clearCodexSpawnLinkCache(): void {
  spawnLinkCache.clear();
}

function freshEntry(size: number, mtimeMs: number): SpawnLinkEntry {
  return {
    size,
    mtimeMs,
    offset: 0,
    historyStart: undefined,
    skipBelow: null,
    pendingSpawns: new Set(),
    links: { started: new Map(), spawnedPaths: new Map() },
  };
}

function historyStartOf(meta: Partial<CodexSessionMeta> | undefined): number | null {
  const value = meta?.subagent_history_start_ordinal;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Applies one rollout line to a spawn-link scan; most lines are rejected by substring. */
function scanLine(entry: SpawnLinkEntry, line: string): void {
  const isMeta = line.includes('"session_meta"');
  const isActivity = line.includes('"SubAgentActivity"');
  const isSpawnCall = line.includes('"spawn_agent"') && line.includes('"function_call"');
  const isOutput = entry.pendingSpawns.size > 0 && line.includes('"function_call_output"');
  if (!isMeta && !isActivity && !isSpawnCall && !isOutput) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const payload = record(parsed.payload);
  if (!payload) return;
  if (parsed.type === 'session_meta') {
    // As the parser: the own meta comes first; an embedded ancestor meta
    // below the history start makes the records below it the parent's.
    if (entry.historyStart === undefined) {
      entry.historyStart = historyStartOf(payload);
    } else if (
      entry.skipBelow === null &&
      typeof entry.historyStart === 'number' &&
      typeof parsed.ordinal === 'number' &&
      parsed.ordinal < entry.historyStart
    ) {
      entry.skipBelow = entry.historyStart;
    }
    return;
  }
  const skipBelow = entry.skipBelow;
  if (skipBelow !== null && typeof parsed.ordinal === 'number' && parsed.ordinal < skipBelow) {
    return; // the parent's history, embedded in a forked child
  }
  if (parsed.type === 'event_msg' && payload.type === 'item_completed') {
    const item = record(payload.item);
    if (item?.type !== 'SubAgentActivity' || item.kind !== 'started') return;
    const threadId = nonEmpty(item.agent_thread_id);
    const callId = nonEmpty(item.id);
    if (!threadId || !callId) return;
    const agentPath = nonEmpty(item.agent_path);
    entry.links.started.set(threadId, { callId, ...(agentPath ? { agentPath } : {}) });
    return;
  }
  if (parsed.type !== 'response_item') return;
  const callId = nonEmpty(payload.call_id);
  if (!callId) return;
  if (payload.type === 'function_call' && payload.name === 'spawn_agent') {
    entry.pendingSpawns.add(callId);
    while (entry.pendingSpawns.size > PENDING_SPAWN_LIMIT) {
      entry.pendingSpawns.delete(entry.pendingSpawns.values().next().value as string);
    }
    return;
  }
  if (payload.type === 'function_call_output' && entry.pendingSpawns.has(callId)) {
    entry.pendingSpawns.delete(callId);
    let output: unknown;
    try {
      output = JSON.parse(String(payload.output));
    } catch {
      return; // e.g. "collab spawn failed: …"
    }
    const taskName = nonEmpty(record(output)?.task_name);
    if (!taskName) return;
    const calls = entry.links.spawnedPaths.get(taskName) ?? [];
    calls.push(callId);
    entry.links.spawnedPaths.set(taskName, calls);
  }
}

function remember(filePath: string, entry: SpawnLinkEntry): void {
  spawnLinkCache.delete(filePath);
  spawnLinkCache.set(filePath, entry);
  while (spawnLinkCache.size > SPAWN_LINK_CACHE_LIMIT) {
    spawnLinkCache.delete(spawnLinkCache.keys().next().value as string);
  }
}

/**
 * The spawn calls a rollout records (see {@link CodexSpawnLinks}). Cached per
 * path; a growing `.jsonl` is read only past what was read before, a
 * compressed one whole. `null` when the rollout cannot be read.
 */
export function readCodexSpawnLinks(
  filePath: string,
  options: ReadRolloutOptions = {},
): CodexSpawnLinks | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    spawnLinkCache.delete(filePath);
    return null;
  }
  let entry = spawnLinkCache.get(filePath);
  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
    remember(filePath, entry);
    return entry.links;
  }

  if (isCompressedRolloutPath(filePath)) {
    const content = readRolloutBuffer(filePath, options);
    if (!content) return null;
    entry = freshEntry(stat.size, stat.mtimeMs);
    for (const line of content.toString('utf8').split('\n')) if (line) scanLine(entry, line);
    remember(filePath, entry);
    return entry.links;
  }

  // A rollout that shrank was replaced: scan it again from the start.
  if (!entry || stat.size < entry.offset || stat.size < entry.size) {
    entry = freshEntry(stat.size, stat.mtimeMs);
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const length = stat.size - entry.offset;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, entry.offset);
      const bytes = buffer.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        for (const line of bytes.toString('utf8', 0, lastNewline).split('\n')) {
          if (line) scanLine(entry, line);
        }
        entry.offset += lastNewline + 1;
      }
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  remember(filePath, entry);
  return entry.links;
}

/**
 * Stats of one subagent rollout from its own records: tool calls, tokens,
 * and first/last timestamps after the embedded parent history (the child's
 * own `session_meta` counts). Reads `.jsonl.zst` when the runtime can.
 * `null` when the rollout is missing or cannot be read.
 */
export function buildCodexSubagentStats(
  agentId: string,
  rolloutPath: string,
  description?: string | null,
  options: ReadRolloutOptions = {},
): SubagentStats | null {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return null;
  const content = readRolloutText(rolloutPath, options);
  if (content === null) return null;

  const stats: SubagentStats = {
    agentId,
    description: description || undefined,
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
  };
  const parser = new CodexRolloutParser();
  let sawMeta = false;
  // The child's last own turn boundary: `task_complete` means it ended cleanly.
  let lastTurnEvent: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: CodexRolloutLine;
    try {
      parsed = JSON.parse(trimmed) as CodexRolloutLine;
    } catch {
      continue;
    }
    let events: SessionEvent[];
    try {
      events = parser.convertLine(parsed);
    } catch {
      continue; // Skip lines the parser rejects.
    }
    // Timestamps of the child's own records only, as the parser decides them.
    let own: boolean;
    if (parsed.type === 'session_meta') {
      own = !sawMeta;
      sawMeta = true;
    } else {
      const end = parser.getInheritedHistoryEnd();
      own = !(end !== null && typeof parsed.ordinal === 'number' && parsed.ordinal < end);
    }
    if (own && parsed.type === 'event_msg') {
      const payloadType = (parsed.payload as { type?: unknown } | undefined)?.type;
      if (
        payloadType === 'task_started' ||
        payloadType === 'task_complete' ||
        payloadType === 'turn_aborted'
      ) {
        lastTurnEvent = payloadType;
      }
    }
    if (own && parsed.timestamp) {
      const ts = new Date(parsed.timestamp);
      if (!Number.isNaN(ts.getTime())) {
        if (!stats.startTime || ts < stats.startTime) stats.startTime = ts;
        if (!stats.endTime || ts > stats.endTime) stats.endTime = ts;
      }
    }
    for (const event of events) {
      if (event.type === 'assistant' && Array.isArray(event.message.content)) {
        for (const block of event.message.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            stats.toolCalls.push({
              name: block.name,
              input: (block.input as Record<string, unknown>) || {},
              timestamp: new Date(event.timestamp),
            });
          }
        }
      }
      // Duplicate token_count events are already dropped by the parser.
      const usage = extractNormalizedUsage(event);
      if (usage) addUsageToSubagent(stats, usage);
    }
  }
  if (stats.startTime && stats.endTime) {
    stats.durationMs = stats.endTime.getTime() - stats.startTime.getTime();
  }
  if (lastTurnEvent) stats.endedCleanly = lastTurnEvent === 'task_complete';
  return stats;
}

/** One subagent thread to describe, from the state database or a rollout. */
interface ChildThread {
  id: string;
  /** The thread that spawned it. */
  parentId: string;
  depth: number;
  /** Stored path (the database keeps `.jsonl` even after compression). */
  rolloutPath: string;
  description?: string | null;
  agentType?: string | null;
  agentNickname?: string | null;
  agentPath?: string | null;
}

export interface DiscoverCodexSubagentsOptions extends ReadRolloutOptions {
  /** The session's state database, when available. */
  db: CodexDatabase | null;
  /** Read compressed rollouts (`.jsonl.zst`) for children whose `.jsonl` is gone. */
  includeCompressed: boolean;
  /** The session's own rollout, or a lookup for it (needed for spawn links). */
  sessionRolloutPath: () => string | null;
  /** Rollouts to inspect when the database has no answer (newest first). */
  fallbackFiles: () => RolloutFileInfo[];
}

function spawnSource(source: unknown): Record<string, unknown> | undefined {
  let value = source;
  if (typeof value === 'string') {
    if (!value.startsWith('{')) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return record(record(record(value)?.subagent)?.thread_spawn);
}

function childFromDbThread(thread: CodexDbThread, parentId: string, depth: number): ChildThread {
  const spawn = spawnSource(thread.source);
  return {
    id: thread.id,
    parentId,
    depth,
    rolloutPath: thread.rollout_path,
    description: thread.title || thread.agent_nickname,
    agentType: thread.agent_role,
    agentNickname: thread.agent_nickname ?? nonEmpty(spawn?.agent_nickname),
    agentPath: thread.agent_path ?? nonEmpty(spawn?.agent_path),
  };
}

/** Children below `sessionId` from the state database; empty when it knows none. */
function childrenFromDb(db: CodexDatabase, sessionId: string): ChildThread[] {
  const children: ChildThread[] = [];
  const seen = new Set<string>();
  for (const spawned of db.getSpawnedDescendantThreads(sessionId)) {
    seen.add(spawned.thread.id);
    children.push(childFromDbThread(spawned.thread, spawned.parentId, spawned.depth));
  }
  // Older schemas record forks in `forked_from_id` (direct children only).
  for (const thread of db.getThreadsByForkedFromId(sessionId)) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    children.push(childFromDbThread(thread, sessionId, 1));
  }
  return children;
}

/** Children below `sessionId` among recent rollouts, by their session_meta. */
function childrenFromFiles(files: RolloutFileInfo[], sessionId: string): ChildThread[] {
  const candidates = files
    .map((file) => ({ file, meta: readSessionMeta(file.path) }))
    .filter((entry): entry is { file: RolloutFileInfo; meta: CodexSessionMeta } => !!entry.meta);
  const depthOf = new Map<string, number>([[sessionId, 0]]);
  const children: ChildThread[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const { file, meta } of candidates) {
      const id = extractRolloutSessionId(path.basename(file.path));
      if (depthOf.has(id)) continue;
      const parentId = meta.forked_from_id ?? spawnParentFromSource(meta.source);
      const parentDepth = parentId !== undefined ? depthOf.get(parentId) : undefined;
      if (parentId === undefined || parentDepth === undefined) continue;
      depthOf.set(id, parentDepth + 1);
      added = true;
      const spawn = spawnSource(meta.source);
      // `source` is a plain string for top-level sessions but an object
      // (`{ subagent: { thread_spawn: … } }`) for spawned children.
      const description =
        meta.agent_nickname || (typeof meta.source === 'string' ? meta.source : undefined);
      children.push({
        id,
        parentId,
        depth: parentDepth + 1,
        rolloutPath: file.path,
        description,
        agentType: meta.agent_role ?? nonEmpty(spawn?.agent_role),
        agentNickname: meta.agent_nickname ?? nonEmpty(spawn?.agent_nickname),
        agentPath: meta.agent_path ?? nonEmpty(spawn?.agent_path),
      });
    }
  }
  return children;
}

/**
 * Every subagent below a session with links and own-record stats. Children
 * whose rollout is gone (or compressed, without `includeCompressed`) are
 * left out, as before.
 */
export function discoverCodexSubagents(
  sessionId: string,
  options: DiscoverCodexSubagentsOptions,
): SubagentStats[] {
  const readOptions: ReadRolloutOptions = { onDiagnostic: options.onDiagnostic };
  let children = options.db ? childrenFromDb(options.db, sessionId) : [];
  if (children.length === 0) children = childrenFromFiles(options.fallbackFiles(), sessionId);
  if (children.length === 0) return [];

  const pathOf = new Map<string, string | null>();
  for (const child of children) {
    pathOf.set(
      child.id,
      resolveRolloutPath(child.rolloutPath, { includeCompressed: options.includeCompressed }),
    );
  }
  const linksOf = new Map<string, CodexSpawnLinks | null>();
  const claimed = new Map<string, Set<string>>();
  const links = (parentId: string): CodexSpawnLinks | null => {
    if (!linksOf.has(parentId)) {
      const parentPath =
        parentId === sessionId ? options.sessionRolloutPath() : (pathOf.get(parentId) ?? null);
      linksOf.set(parentId, parentPath ? readCodexSpawnLinks(parentPath, readOptions) : null);
    }
    return linksOf.get(parentId) ?? null;
  };

  // Started links first, so the agent-path fallback never takes a claimed call.
  const linked = new Map<string, string>();
  for (const child of children) {
    const callId = links(child.parentId)?.started.get(child.id)?.callId;
    if (!callId) continue;
    linked.set(child.id, callId);
    const set = claimed.get(child.parentId) ?? new Set<string>();
    set.add(callId);
    claimed.set(child.parentId, set);
  }

  const results: SubagentStats[] = [];
  for (const child of children) {
    const filePath = pathOf.get(child.id);
    if (!filePath) continue;
    const built = cachedSubagentStats(filePath, () =>
      buildCodexSubagentStats(child.id, filePath, child.description, readOptions),
    );
    if (!built) continue;
    let spawnToolUseId = linked.get(child.id);
    const parentLinks = links(child.parentId);
    const agentPath = child.agentPath ?? parentLinks?.started.get(child.id)?.agentPath;
    if (!spawnToolUseId && agentPath && parentLinks) {
      const used = claimed.get(child.parentId) ?? new Set<string>();
      spawnToolUseId = parentLinks.spawnedPaths.get(agentPath)?.find((id) => !used.has(id));
      if (spawnToolUseId) {
        used.add(spawnToolUseId);
        claimed.set(child.parentId, used);
      }
    }
    results.push({
      ...built,
      ...(child.agentType && !built.agentType ? { agentType: child.agentType } : {}),
      filePath,
      ...(spawnToolUseId ? { spawnToolUseId } : {}),
      ...(child.agentNickname ? { agentNickname: child.agentNickname } : {}),
      ...(agentPath ? { agentPath } : {}),
      parentAgentId: child.parentId,
      depth: child.depth,
    });
  }
  return results;
}
