/**
 * Locates the session record that issued each of a set of tool calls, by id.
 *
 * Given Claude Code `tool_use` ids and Codex call or completed-item ids, finds
 * the session file, session id and time of each call, plus the ordinal of the
 * human prompt the call answered, so a downstream record (an edit, a commit)
 * can be tied back to the prompt that caused it. Scope, listing, session keys
 * and ordinals are the ones `collectPromptHistory()` uses, so results join
 * directly with prompt-history entries.
 *
 * Cost: one listing of the workspace-scoped session files (`since` prunes by
 * modification time), then a streaming pass over each candidate file in which
 * Codex call boundaries are parsed to identify enclosing calls. Claude Code
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
import { isCompressedRolloutPath, readRolloutBufferAsync } from './providers/compressedRollouts';
import type { SessionHomesOptions } from './agentHomes';
import type { SessionListing } from './sessionListing';
import {
  candidateListingDirs,
  listCandidates,
  listingCandidates,
  listingOption,
  readPromptOrdinalMarks,
  resolveRoots,
  type Candidate,
  type PromptHistoryProvider,
  type PromptOrdinalMark,
} from './promptHistory';
import { getClaudeSubagentsDir, parseClaudeSubagentFileName } from './claudePaths';
import { codexRolloutOrigin } from './parsers/codexRolloutOrigin';
import { findCodexRolloutFile, readFirstLineAsync } from './providers/codexRollouts';
import { resolveMonitoredHomes } from './monitoredHomes';
import {
  codexRolloutHead,
  ordinalAtOrBefore,
  readCodexRolloutHead,
  readFirstRecordTimestamp,
  resolveCodexRoot,
  type CodexRolloutHead,
} from './usage/subagentLineage';
import { pathWithinRoots } from './workspaceRoots';

export interface FindToolCallOriginsOptions {
  /** Tool-call ids to locate: Claude `tool_use` ids, Codex `call_id`s or completed-item ids. */
  ids: Iterable<string>;
  /** Workspace roots that scope the search (as for `collectPromptHistory`). Required unless `listing` is given. */
  workspacePaths?: string[];
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
  /** Claude Code and Codex homes to read, as for `collectPromptHistory()`. */
  homes?: SessionHomesOptions;
  /**
   * A listing from `listAgentSessions()` to use instead of listing again:
   * its roots, homes, worktree expansion and compressed-rollout choice
   * apply, so passing `workspacePaths`, `includeWorktrees`, `homes` or
   * `includeCompressedRollouts` with it is a `TypeError`.
   */
  listing?: SessionListing;
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
  enclosingCallId?: string;
  enclosingToolName?: string;
  /** Set when a subagent issued the call. */
  subagent?: { agentId: string; parentSessionId: string };
  /**
   * Subagent calls only: the ordinal of the root session's prompt in effect
   * when the subagent started, as `UsageEventRecord.parentPromptOrdinal`
   * defines it. Null when the root was not found or is out of scope, or no
   * prompt precedes the start. Absent for forks and the session's own calls.
   */
  parentPromptOrdinal?: number | null;
}

interface Hit {
  id: string;
  timestamp: string;
  timestampMs: number;
  toolName?: string;
  enclosingCallId?: string;
  enclosingToolName?: string;
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
  const listing = listingOption('findToolCallOrigins', options);
  const listingDirs = listing ? undefined : candidateListingDirs(options.homes);

  const realpaths = new Map<string, string | null>();
  const { roots, listingRoots } = listing
    ? { roots: listing.roots, listingRoots: listing.listingRoots }
    : resolveRoots(options.workspacePaths ?? [], options.includeWorktrees !== false, realpaths);
  if (roots.length === 0) return found;
  const providers = options.providers ?? ['claude-code', 'codex'];
  const sinceMs = options.since ? options.since.getTime() : null;
  const candidates = listing
    ? listingCandidates(listing, providers, sinceMs)
    : await listCandidates(providers, listingRoots, sinceMs, {
        includeCompressedRollouts: options.includeCompressedRollouts,
        dirs: listingDirs,
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
  const parentPrompt = parentPromptResolver({
    candidates,
    roots,
    realpaths,
    marksFor,
    codexHomes: listing
      ? listing.homes.codex
      : options.homes
        ? resolveMonitoredHomes(options.homes).codex
        : undefined,
    includeCompressed: listing
      ? listing.includeCompressedRollouts
      : options.includeCompressedRollouts === true,
  });

  for (const candidate of candidates) {
    if (remaining.size === 0) break;
    throwIfAborted(options.signal);
    const targets: ScanTarget[] = [{ candidate, filePath: candidate.filePath }];
    if (candidate.provider === 'claude-code') {
      for (const sub of claudeSubagentTranscripts(candidate.filePath)) {
        targets.push({ candidate, filePath: sub.filePath, agentId: sub.agentId });
      }
    }
    // A Codex fork or spawned subagent answers its parent's prompts.
    let codexParent: { id: string; fork: boolean } | undefined;
    let codexHead: CodexRolloutHead | undefined;
    if (candidate.provider === 'codex') {
      const first = await readFirstRecord(candidate.filePath);
      const origin = codexRolloutOrigin(first);
      if (origin.parentId) codexParent = { id: origin.parentId, fork: !origin.isSubagent };
      codexHead = codexRolloutHead(candidate.sessionId, first);
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
            ? ordinalAtOrBefore(await marksFor(session), hit.timestampMs)
            : null;
        let parentPromptOrdinal: number | null | undefined;
        if (target.agentId) {
          parentPromptOrdinal = await parentPrompt.claude(candidate, target.filePath);
        } else if (subagent && codexHead) {
          parentPromptOrdinal = await parentPrompt.codex(codexHead);
        }
        found.set(hit.id, {
          provider: candidate.provider,
          sessionId: session.sessionId,
          sessionKey: session.key,
          filePath: target.filePath,
          timestamp: hit.timestamp,
          afterOrdinal,
          ...(hit.toolName ? { toolName: hit.toolName } : {}),
          ...(hit.enclosingCallId
            ? { enclosingCallId: hit.enclosingCallId, enclosingToolName: hit.enclosingToolName }
            : {}),
          ...(subagent ? { subagent } : {}),
          ...(parentPromptOrdinal !== undefined ? { parentPromptOrdinal } : {}),
        });
        // A fork's copy might be replaced by the original later; keep looking.
        if (!isFork) remaining.delete(hit.id);
      }
      if (remaining.size === 0) break;
    }
  }
  return found;
}

/** Parent-prompt lookups for one call, memoized per file and session. */
function parentPromptResolver(context: {
  candidates: readonly Candidate[];
  roots: string[];
  realpaths: Map<string, string | null>;
  marksFor: (candidate: Candidate) => Promise<PromptOrdinalMark[]>;
  codexHomes: readonly string[] | undefined;
  includeCompressed: boolean;
}) {
  const codexById = new Map<string, Candidate>();
  for (const candidate of context.candidates) {
    if (candidate.provider === 'codex') codexById.set(candidate.sessionId, candidate);
  }
  const starts = new Map<string, Promise<number | null>>();
  const heads = new Map<string, Promise<{ head: CodexRolloutHead; filePath: string } | null>>();
  const rootMarks = new Map<string, Promise<PromptOrdinalMark[] | null>>();

  const locate = (sessionId: string) => {
    let found = heads.get(sessionId);
    if (!found) {
      found = (async () => {
        const listed = codexById.get(sessionId);
        const filePath =
          listed?.filePath ??
          findCodexRolloutFile(sessionId, {
            includeCompressed: context.includeCompressed,
            ...(context.codexHomes ? { codexHomes: context.codexHomes } : {}),
          });
        if (!filePath) return null;
        const head = await readCodexRolloutHead(sessionId, filePath);
        if (!head) return null;
        // A root found outside the listing must still be in scope.
        if (!listed && !pathWithinRoots(head.cwd, context.roots, context.realpaths)) return null;
        return { head, filePath };
      })();
      heads.set(sessionId, found);
    }
    return found;
  };

  return {
    async claude(candidate: Candidate, transcript: string): Promise<number | null> {
      let start = starts.get(transcript);
      if (!start) {
        start = readFirstRecordTimestamp(transcript);
        starts.set(transcript, start);
      }
      return ordinalAtOrBefore(await context.marksFor(candidate), await start);
    },
    async codex(head: CodexRolloutHead): Promise<number | null> {
      const resolved = await resolveCodexRoot(head, async (id) => (await locate(id))?.head ?? null);
      if (!resolved.rootSessionId || !resolved.root) return null;
      // The candidate listing is a superset of the scope, so a listed root is
      // checked too: an out-of-scope root supplies no parent prompt.
      if (!pathWithinRoots(resolved.root.cwd, context.roots, context.realpaths)) return null;
      const rootId = resolved.rootSessionId;
      let marks = rootMarks.get(rootId);
      if (!marks) {
        marks = (async () => {
          const listed = codexById.get(rootId);
          if (listed) return context.marksFor(listed);
          const located = await locate(rootId);
          return located
            ? readPromptOrdinalMarks('codex', rootId, located.filePath).catch(() => null)
            : null;
        })();
        rootMarks.set(rootId, marks);
      }
      const found = await marks;
      return found ? ordinalAtOrBefore(found, head.startMs) : null;
    },
  };
}

/** The session's `agent-<id>.jsonl` subagent transcripts, sorted by name. */
function claudeSubagentTranscripts(sessionFile: string): { filePath: string; agentId: string }[] {
  const dir = getClaudeSubagentsDir(sessionFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const transcripts: { filePath: string; agentId: string }[] = [];
  for (const name of names.sort()) {
    const agentId = parseClaudeSubagentFileName(name);
    if (agentId) transcripts.push({ filePath: path.join(dir, name), agentId });
  }
  return transcripts;
}

async function readFirstRecord(filePath: string): Promise<unknown> {
  try {
    // A compressed rollout's head is decompressed.
    const { line: text } = await readFirstLineAsync(filePath);
    if (!text) return undefined;
    const newline = text.indexOf('\n');
    return JSON.parse(newline === -1 ? text : text.slice(0, newline));
  } catch {
    return undefined;
  }
}

/** Fail-closed scope check on a recorded working directory. */
function inScope(cwd: unknown, roots: string[], realpaths: Map<string, string | null>): boolean {
  return pathWithinRoots(cwd, roots, realpaths) !== null;
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
  let sawMeta = false;
  const calls = new Map<string, { turn: string; family: string; name: string; hits: Hit[] }>();
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      let boundary:
        | {
            type?: string;
            payload?: {
              type?: string;
              cwd?: unknown;
              call_id?: string;
              name?: string;
              turn_id?: string;
              internal_chat_message_metadata_passthrough?: { turn_id?: string };
            };
          }
        | undefined;
      if (provider === 'codex') {
        try {
          boundary = JSON.parse(line);
        } catch {
          continue;
        }
        if (boundary?.type === 'session_meta' && !sawMeta) {
          sawMeta = true;
          codexCwd = boundary.payload?.cwd;
        } else if (boundary?.type === 'turn_context' && boundary.payload?.cwd !== undefined) {
          codexCwd = boundary.payload.cwd;
        }
        const p = boundary?.payload;
        const turn = p?.internal_chat_message_metadata_passthrough?.turn_id;
        if (
          boundary?.type === 'response_item' &&
          typeof p?.call_id === 'string' &&
          typeof turn === 'string' &&
          turn
        ) {
          if (typeof p.type === 'string' && p.type.endsWith('_call')) {
            calls.set(p.call_id, {
              turn,
              family: p.type,
              name: p.name ?? p.type.replace(/_call$/, ''),
              hits: [],
            });
          } else if (typeof p.type === 'string' && p.type.endsWith('_call_output')) {
            const call = calls.get(p.call_id);
            if (call && call.turn === turn && p.type === call.family + '_output') {
              for (const hit of call.hits) {
                hit.enclosingCallId = p.call_id;
                hit.enclosingToolName = call.name;
              }
              calls.delete(p.call_id);
            }
          }
        }
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
      if (boundary?.type === 'event_msg' && boundary.payload?.type === 'item_completed') {
        const active = [...calls.values()].filter(
          (call) => call.turn === boundary?.payload?.turn_id,
        );
        if (active.length === 1) active[0].hits.push(...lineHits);
      }
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
    payload?: {
      type?: unknown;
      call_id?: unknown;
      name?: unknown;
      item?: { id?: unknown; type?: unknown };
    };
  };
  if (row?.type === 'event_msg' && row.payload?.type === 'item_completed') {
    const item = row.payload.item;
    const time = timeOf(record);
    if (!time || typeof item?.id !== 'string' || !wanted.has(item.id)) return [];
    return [
      { id: item.id, ...time, ...(typeof item.type === 'string' ? { toolName: item.type } : {}) },
    ];
  }
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
