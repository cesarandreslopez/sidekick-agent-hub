/**
 * Locates the session record that issued each of a set of tool calls, by id.
 *
 * Given Claude Code `tool_use` ids (`toolu_…`) and/or Codex `call_id`s, finds
 * the session file, session id and time of each call, plus the ordinal of the
 * human prompt the call answered, so a downstream record (an edit, a commit)
 * can be tied back to the prompt that caused it. Scope, listing, session keys
 * and ordinals are the ones `collectPromptHistory()` uses, so results join
 * directly with prompt-history entries.
 *
 * Cost: one listing of the workspace-scoped session files (`since` prunes by
 * modification time), then a streaming pass over each candidate file in which
 * a line is only parsed when it contains one of the wanted ids. Claude Code
 * subagent transcripts of each session are searched too. Stops as soon as
 * every id is found. Prompt ordinals are read only for files that matched.
 *
 * Node-only: reads session files.
 *
 * @module toolCallOrigins
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Readable } from 'stream';
import {
  isCompressedRolloutPath,
  readRolloutBufferAsync,
  readRolloutHeadAsync,
} from './providers/compressedRollouts';
import {
  listCandidates,
  readPromptOrdinalMarks,
  resolveRoots,
  type Candidate,
  type PromptHistoryProvider,
  type PromptOrdinalMark,
} from './promptHistory';
import { codexRolloutOrigin } from './parsers/codexRolloutOrigin';
import { realpathOrNull } from './workspaceRoots';

export interface FindToolCallOriginsOptions {
  /** Tool-call ids to locate: Claude `tool_use` ids and/or Codex `call_id`s. */
  ids: Iterable<string>;
  /** Workspace roots that scope the search (as for `collectPromptHistory`). */
  workspacePaths: string[];
  /** Also search the roots' git worktree siblings. Default true. */
  includeWorktrees?: boolean;
  /** Only session files modified at or after this instant. */
  since?: Date;
  /** Default both. */
  providers?: PromptHistoryProvider[];
  /** Stops between files and lines; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Codex: also search compressed rollouts (`….jsonl.zst`), as for
   * `collectPromptHistory()`. Default false.
   */
  includeCompressedRollouts?: boolean;
}

export interface ToolCallOrigin {
  provider: PromptHistoryProvider;
  /**
   * Session whose prompt history `afterOrdinal` counts in: the session itself,
   * or its parent for a subagent or fork (Claude subagent transcripts live
   * under the parent; a Codex subagent or fork has its own rollout, named in
   * `subagent.agentId` / `filePath`, and no prompts of its own).
   */
  sessionId: string;
  /** Same key `collectPromptHistory()` reports for that session's file. */
  sessionKey: string;
  /** File the call was recorded in (a subagent transcript for subagent calls). */
  filePath: string;
  /** ISO timestamp of the record that issued the call. */
  timestamp: string;
  /**
   * Ordinal of the last human prompt at or before the call, in the session's
   * prompt history; null when the call precedes every prompt or the session
   * has none (e.g. a Codex subagent whose parent was not found in scope).
   */
  afterOrdinal: number | null;
  toolName?: string;
  /** Set when a subagent issued the call. */
  subagent?: { agentId: string; parentSessionId: string };
}

interface Hit {
  id: string;
  timestamp: string;
  timestampMs: number;
  toolName?: string;
}

interface ScanTarget {
  candidate: Candidate;
  filePath: string;
  agentId?: string;
}

/**
 * Finds where each tool call was issued. Ids that are not found are absent
 * from the result. When an id appears more than once (a forked or resumed
 * session can replay history), the earliest record wins, and a session's own
 * record wins over a fork's copy at the same instant.
 */
export async function findToolCallOrigins(
  options: FindToolCallOriginsOptions,
): Promise<Map<string, ToolCallOrigin>> {
  const wanted = new Set([...options.ids].filter((id) => typeof id === 'string' && id.length > 0));
  const found = new Map<string, ToolCallOrigin>();
  if (wanted.size === 0) return found;
  throwIfAborted(options.signal);

  const realpaths = new Map<string, string | null>();
  const { roots, listingRoots } = resolveRoots(
    options.workspacePaths,
    options.includeWorktrees !== false,
    realpaths,
  );
  if (roots.length === 0) return found;
  const providers = options.providers ?? ['claude-code', 'codex'];
  const sinceMs = options.since ? options.since.getTime() : null;
  const candidates = await listCandidates(providers, listingRoots, sinceMs, {
    includeCompressedRollouts: options.includeCompressedRollouts,
  });
  const byProviderSession = new Map<string, Candidate>();
  for (const candidate of candidates) {
    byProviderSession.set(`${candidate.provider}:${candidate.sessionId}`, candidate);
  }

  const marksCache = new Map<string, Promise<PromptOrdinalMark[]>>();
  const marksFor = (candidate: Candidate): Promise<PromptOrdinalMark[]> => {
    let marks = marksCache.get(candidate.key);
    if (!marks) {
      marks = readPromptOrdinalMarks(
        candidate.provider,
        candidate.sessionId,
        candidate.filePath,
      ).catch(() => []);
      marksCache.set(candidate.key, marks);
    }
    return marks;
  };
  const remaining = new Set(wanted);
  // Best timestamp seen per id, to prefer the earliest record across files.
  const bestMs = new Map<string, { ms: number; fork: boolean }>();

  for (const candidate of candidates) {
    if (remaining.size === 0) break;
    throwIfAborted(options.signal);
    const targets: ScanTarget[] = [{ candidate, filePath: candidate.filePath }];
    if (candidate.provider === 'claude-code') {
      for (const sub of claudeSubagentTranscripts(candidate.filePath, candidate.sessionId)) {
        targets.push({ candidate, filePath: sub.filePath, agentId: sub.agentId });
      }
    }
    // A Codex fork or spawned subagent answers its parent's prompts.
    let codexParent: { id: string; fork: boolean } | undefined;
    if (candidate.provider === 'codex') {
      const origin = codexRolloutOrigin(await readFirstRecord(candidate.filePath));
      if (origin.parentId) codexParent = { id: origin.parentId, fork: !origin.isSubagent };
    }

    for (const target of targets) {
      const hits = await scanForIds(
        target.filePath,
        candidate.provider,
        remaining,
        roots,
        realpaths,
        options.signal,
      );
      for (const hit of hits) {
        const isFork = codexParent?.fork === true;
        const previous = bestMs.get(hit.id);
        if (
          previous &&
          (previous.ms < hit.timestampMs ||
            (previous.ms === hit.timestampMs && (!previous.fork || isFork)))
        ) {
          continue;
        }
        bestMs.set(hit.id, { ms: hit.timestampMs, fork: isFork });

        let subagent: ToolCallOrigin['subagent'];
        if (target.agentId) {
          subagent = { agentId: target.agentId, parentSessionId: candidate.sessionId };
        } else if (codexParent && !codexParent.fork) {
          subagent = { agentId: candidate.sessionId, parentSessionId: codexParent.id };
        }
        // Ordinals come from the session whose prompts the call answered: a
        // Codex fork or subagent has none of its own, so its parent's count.
        const parentSession = codexParent
          ? byProviderSession.get(`codex:${codexParent.id}`)
          : undefined;
        const session = parentSession ?? candidate;
        const afterOrdinal =
          !codexParent || parentSession
            ? ordinalAt(await marksFor(session), hit.timestampMs)
            : null;
        found.set(hit.id, {
          provider: candidate.provider,
          sessionId: session.sessionId,
          sessionKey: session.key,
          filePath: target.filePath,
          timestamp: hit.timestamp,
          afterOrdinal,
          ...(hit.toolName ? { toolName: hit.toolName } : {}),
          ...(subagent ? { subagent } : {}),
        });
        // A fork's copy might be replaced by the original later; keep looking.
        if (!isFork) remaining.delete(hit.id);
      }
      if (remaining.size === 0) break;
    }
  }
  return found;
}

/** Highest ordinal among prompts at or before `ms`; marks are in file order. */
function ordinalAt(marks: readonly PromptOrdinalMark[], ms: number): number | null {
  let best: number | null = null;
  for (const mark of marks) {
    if (Number.isFinite(mark.timestampMs) && mark.timestampMs <= ms) {
      if (best === null || mark.ordinal > best) best = mark.ordinal;
    }
  }
  return best;
}

function claudeSubagentTranscripts(
  sessionFile: string,
  sessionId: string,
): { filePath: string; agentId: string }[] {
  const dir = path.join(path.dirname(sessionFile), sessionId, 'subagents');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({
      filePath: path.join(dir, name),
      agentId: path.basename(name, '.jsonl').replace(/^agent-/, ''),
    }));
}

async function readFirstRecord(filePath: string): Promise<unknown> {
  try {
    // A compressed rollout's head is decompressed.
    const text = (await readRolloutHeadAsync(filePath, 256 * 1024)).toString('utf8');
    const newline = text.indexOf('\n');
    return JSON.parse(newline === -1 ? text : text.slice(0, newline));
  } catch {
    return undefined;
  }
}

/** Fail-closed scope check on a recorded working directory. */
function inScope(cwd: unknown, roots: string[], realpaths: Map<string, string | null>): boolean {
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const real = realpathOrNull(cwd, realpaths);
  if (!real) return false;
  return roots.some((root) => {
    if (real === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return real.startsWith(prefix);
  });
}

const ID_PATTERN = /"(?:id|call_id)"\s*:\s*"([^"\\]{1,256})"/g;

async function scanForIds(
  filePath: string,
  provider: PromptHistoryProvider,
  wanted: ReadonlySet<string>,
  roots: string[],
  realpaths: Map<string, string | null>,
  signal: AbortSignal | undefined,
): Promise<Hit[]> {
  const hits: Hit[] = [];
  let stream: Readable;
  try {
    if (isCompressedRolloutPath(filePath)) {
      // Compressed rollouts are complete; search their decompressed content.
      const content = await readRolloutBufferAsync(filePath);
      if (!content) return hits;
      stream = Readable.from([content.toString('utf8')]);
    } else {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    }
  } catch {
    return hits;
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Codex records a working directory per session/turn, not per line.
  let codexCwd: unknown;
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      if (provider === 'codex' && line.includes('"cwd"')) {
        const cwd = codexCwdOf(line);
        if (cwd !== undefined) codexCwd = cwd;
      }
      let match = false;
      for (const found of line.matchAll(ID_PATTERN)) {
        if (wanted.has(found[1])) {
          match = true;
          break;
        }
      }
      if (!match) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const lineHits =
        provider === 'claude-code' ? claudeToolUses(record, wanted) : codexToolCall(record, wanted);
      if (lineHits.length === 0) continue;
      const cwd = provider === 'claude-code' ? (record as { cwd?: unknown }).cwd : codexCwd;
      if (!inScope(cwd, roots, realpaths)) continue;
      hits.push(...lineHits);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Unreadable or vanished file: keep what was found.
  } finally {
    lines.close();
    stream.destroy();
  }
  return hits;
}

function codexCwdOf(line: string): unknown {
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } };
    if (record.type === 'session_meta' || record.type === 'turn_context') {
      return record.payload?.cwd;
    }
  } catch {
    // Not a complete record.
  }
  return undefined;
}

function timeOf(record: unknown): { timestamp: string; timestampMs: number } | null {
  const timestamp = (record as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== 'string') return null;
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) ? { timestamp, timestampMs } : null;
}

function claudeToolUses(record: unknown, wanted: ReadonlySet<string>): Hit[] {
  const row = record as { type?: unknown; message?: { content?: unknown } };
  if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) return [];
  const time = timeOf(record);
  if (!time) return [];
  const hits: Hit[] = [];
  for (const block of row.message.content as unknown[]) {
    const item = block as { type?: unknown; id?: unknown; name?: unknown };
    if (
      (item?.type === 'tool_use' || item?.type === 'server_tool_use') &&
      typeof item.id === 'string' &&
      wanted.has(item.id)
    ) {
      hits.push({
        id: item.id,
        ...time,
        ...(typeof item.name === 'string' ? { toolName: item.name } : {}),
      });
    }
  }
  return hits;
}

function codexToolCall(record: unknown, wanted: ReadonlySet<string>): Hit[] {
  const row = record as {
    type?: unknown;
    payload?: { type?: unknown; call_id?: unknown; name?: unknown };
  };
  const payloadType = row?.payload?.type;
  if (
    row?.type !== 'response_item' ||
    typeof payloadType !== 'string' ||
    !payloadType.endsWith('_call')
  ) {
    return [];
  }
  const callId = row.payload?.call_id;
  if (typeof callId !== 'string' || !wanted.has(callId)) return [];
  const time = timeOf(record);
  if (!time) return [];
  const name = row.payload?.name;
  return [
    {
      id: callId,
      ...time,
      toolName: typeof name === 'string' ? name : payloadType.replace(/_call$/, ''),
    },
  ];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw (
      signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );
  }
}
