/**
 * Subagent execution trace parser.
 *
 * Extends the existing subagent scanner to preserve full conversation events
 * (not just stats) for drill-down trace visualization. Applies noise classification
 * and tool summary formatting from the formatters module.
 *
 * Parent-child linking, exact links first:
 * 1. Meta `parentAgentId` (Claude Code writes it for nested spawns)
 * 2. The child's spawning tool_use id (meta `toolUseId`) found in another
 *    trace's `Agent` / `Task` calls
 * Only traces without that spawn metadata (older Claude Code) fall back to:
 * 3. Team summary: parse <teammate-message> XML blocks
 * 4. Positional fallback: timestamp ordering + proximity
 *
 * @module parsers/subagentTraceParser
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionEvent, SubagentStats, ToolCall } from '../types/sessionEvent';
import { formatToolSummary } from '../formatters/toolSummary';
import { isHardNoise, classifyMessage, getSoftNoiseReason } from '../formatters/noiseClassifier';
import type { MessageClassification } from '../formatters/noiseClassifier';
import { ClaudeUsageDeduper, dedupedRawClaudeUsage } from '../usage/claudeUsageDedupe';
import { addUsageToSubagent } from '../usage/subagentUsage';
import { readAgentMeta } from './subagentScanner';
import { isSubagentSpawnTool } from '../subagentSpawn';
import { ownValue } from '../ownKey';

// ── Types ──

export interface SubagentTraceEvent {
  /** The raw session event */
  event: SessionEvent;
  /** Formatted tool summary (for tool_use events) */
  toolSummary?: string;
  /** Noise classification */
  noiseLevel: 'user' | 'ai' | 'system' | 'noise';
  /** Semantic message classification */
  messageClassification: MessageClassification;
  /** Soft noise reason if applicable */
  softNoiseReason?: string;
  /** Whether this is hard noise (should be filtered by default) */
  isHardNoise: boolean;
}

export interface SubagentTrace {
  /** Agent identifier (from filename) */
  agentId: string;
  /** Agent type (e.g., "Explore", "Plan") */
  agentType?: string;
  /** Short description */
  description?: string;
  /** Full conversation events with formatting applied */
  events: SubagentTraceEvent[];
  /** Child subagent traces (recursively nested) */
  children: SubagentTrace[];
  /** Basic stats (tokens, duration, etc.) */
  stats: SubagentStats;
  /**
   * Parent tool_use_id that spawned this agent: the spawning `Agent` / `Task`
   * call's id when Claude Code recorded it (also for top-level traces, whose
   * spawn is in the main session). For a heuristic link without that
   * metadata it holds the parent's agent id, as before; see `parentAgentId`.
   */
  parentToolUseId?: string;
  /** Path of this agent's `agent-<id>.jsonl` transcript. */
  filePath?: string;
  /** The tool_use id of the call that spawned this agent (meta `toolUseId`). */
  spawnToolUseId?: string;
  /** Agent id of the parent trace, for agents spawned by another subagent. */
  parentAgentId?: string;
  /** Launched in the background (meta `requestShape: 'background'`). */
  background?: boolean;
  /** Claude Code marked the background agent done (meta `finished`). */
  finished?: boolean;
  /** The user stopped the agent (meta `stoppedByUser`). */
  stoppedByUser?: boolean;
}

// ── Constants ──

const AGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;

// ── Public API ──

/**
 * Scans and parses subagent traces with full conversation events.
 *
 * Unlike `scanSubagentDir()` which only returns stats, this returns
 * the full conversation trace for each subagent, formatted with tool
 * summaries and noise classification.
 *
 * @param sessionDir - Directory containing the session file
 * @param sessionId - Session ID (filename without .jsonl extension)
 * @returns Array of SubagentTrace objects forming a tree
 */
export function scanSubagentTraces(sessionDir: string, sessionId: string): SubagentTrace[] {
  const subagentsDir = path.join(sessionDir, sessionId, 'subagents');

  try {
    if (!fs.existsSync(subagentsDir)) return [];

    const files = fs.readdirSync(subagentsDir);
    const traces: SubagentTrace[] = [];

    for (const file of files) {
      const match = file.match(AGENT_FILE_PATTERN);
      if (!match) continue;

      const agentId = match[1];
      const filePath = path.join(subagentsDir, file);
      const trace = parseAgentTrace(filePath, agentId);
      if (trace) traces.push(trace);
    }

    // Link parent-child relationships; returns the traces with no parent agent.
    return linkTraces(traces);
  } catch {
    return [];
  }
}

// ── Parsing ──

function parseAgentTrace(filePath: string, agentId: string): SubagentTrace | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    const events: SubagentTraceEvent[] = [];
    const toolCalls: ToolCall[] = [];
    let agentType: string | undefined;
    let description: string | undefined;
    const tokens: SubagentStats = { agentId, toolCalls: [], inputTokens: 0, outputTokens: 0 };
    const usageDeduper = new ClaudeUsageDeduper();
    let startTime: Date | undefined;
    let endTime: Date | undefined;

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const timestamp = new Date(raw.timestamp || Date.now());
        if (!startTime) startTime = timestamp;
        endTime = timestamp;

        // Build SessionEvent from raw JSONL
        const sessionEvent = rawToSessionEvent(raw);
        if (!sessionEvent) continue;

        // Classify and format
        const hardNoise = isHardNoise(sessionEvent);
        const messageClass = classifyMessage(sessionEvent);
        const softNoise = getSoftNoiseReason(sessionEvent);

        // Compute noise level
        let noiseLevel: SubagentTraceEvent['noiseLevel'] = 'system';
        switch (sessionEvent.type) {
          case 'user':
            noiseLevel = 'user';
            break;
          case 'assistant':
            noiseLevel = 'ai';
            break;
          case 'tool_use':
            noiseLevel = 'system';
            break;
          case 'tool_result':
            noiseLevel = 'noise';
            break;
          case 'summary':
            noiseLevel = 'system';
            break;
        }

        // Format tool summary
        let toolSummary: string | undefined;
        if (sessionEvent.tool) {
          toolSummary = formatToolSummary(sessionEvent.tool.name, sessionEvent.tool.input);
        }

        events.push({
          event: sessionEvent,
          toolSummary,
          noiseLevel,
          messageClassification: messageClass,
          softNoiseReason: softNoise ?? undefined,
          isHardNoise: hardNoise,
        });

        // Extract token usage
        // Split lines of one response repeat its usage; count each response once.
        const usage = dedupedRawClaudeUsage(raw, usageDeduper);
        if (usage) addUsageToSubagent(tokens, usage);

        // Extract tool calls
        if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block?.type === 'tool_use') {
              toolCalls.push({
                name: block.name,
                input: block.input || {},
                timestamp,
              });

              // Extract agent info from an Agent/Task spawn
              if (isSubagentSpawnTool(block.name) && block.input) {
                if (block.input.subagent_type && !agentType) {
                  agentType = String(block.input.subagent_type);
                }
                if (block.input.description && !description) {
                  description = String(block.input.description);
                }
              }
            }
          }
        }

        // Extract agent type from system messages
        if (raw.type === 'system' && raw.message?.content) {
          const contentStr =
            typeof raw.message.content === 'string'
              ? raw.message.content
              : JSON.stringify(raw.message.content);
          const typeMatch = contentStr.match(/subagent_type['":\s]+(\w+)/i);
          if (typeMatch && !agentType) {
            agentType = typeMatch[1];
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    const meta = readAgentMeta(filePath);
    agentType = meta.agentType ?? agentType;
    description = meta.description ?? description;

    if (events.length === 0 && !agentType && !description && !tokens.totalTokens) {
      return null;
    }

    const durationMs = startTime && endTime ? endTime.getTime() - startTime.getTime() : undefined;

    return {
      agentId,
      agentType,
      description,
      filePath,
      ...(meta.toolUseId
        ? { spawnToolUseId: meta.toolUseId, parentToolUseId: meta.toolUseId }
        : {}),
      ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId } : {}),
      ...(meta.requestShape ? { background: meta.requestShape === 'background' } : {}),
      ...(meta.finished !== undefined ? { finished: meta.finished } : {}),
      ...(meta.stoppedByUser !== undefined ? { stoppedByUser: meta.stoppedByUser } : {}),
      events,
      children: [],
      stats: {
        agentId,
        agentType,
        description,
        toolCalls,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens ?? 0,
        cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
        reasoningTokens: tokens.reasoningTokens ?? 0,
        totalTokens: tokens.totalTokens ?? 0,
        startTime,
        endTime,
        durationMs,
      },
    };
  } catch {
    return null;
  }
}

// ── Parent-Child Linking ──

/**
 * Nests child traces under their parents and returns the traces with no
 * parent agent. Exact metadata links come first; the heuristics only place
 * traces Claude Code recorded no spawn metadata for.
 */
function linkTraces(traces: SubagentTrace[]): SubagentTrace[] {
  const traceById = new Map<string, SubagentTrace>();
  for (const trace of traces) {
    traceById.set(trace.agentId, trace);
  }
  const parentOf = new Map<SubagentTrace, SubagentTrace>();

  const attach = (parent: SubagentTrace, child: SubagentTrace): boolean => {
    if (parent === child || parentOf.has(child)) return false;
    // Never nest an agent under its own descendant (malformed metadata).
    for (let up: SubagentTrace | undefined = parent; up; up = parentOf.get(up)) {
      if (up === child) return false;
    }
    parentOf.set(child, parent);
    parent.children.push(child);
    return true;
  };

  // Phase 1: the meta file names the parent agent
  for (const child of traces) {
    const parent = child.parentAgentId ? traceById.get(child.parentAgentId) : undefined;
    if (parent) attach(parent, child);
  }

  // Phase 2: the child's spawning call is in another trace
  const spawnOwner = new Map<string, SubagentTrace>();
  for (const trace of traces) {
    for (const id of spawnToolUseIdsOf(trace)) {
      if (!spawnOwner.has(id)) spawnOwner.set(id, trace);
    }
  }
  for (const child of traces) {
    if (parentOf.has(child) || !child.spawnToolUseId) continue;
    const parent = spawnOwner.get(child.spawnToolUseId);
    if (parent && attach(parent, child)) child.parentAgentId ??= parent.agentId;
  }

  // Heuristic links set parentAgentId and, as before, parentToolUseId to the
  // parent's agent id.
  const unresolved = (trace: SubagentTrace): boolean =>
    !parentOf.has(trace) && !trace.spawnToolUseId && !trace.parentAgentId;
  const linkHeuristically = (parent: SubagentTrace, child: SubagentTrace): boolean => {
    if (!attach(parent, child)) return false;
    child.parentAgentId = parent.agentId;
    child.parentToolUseId = parent.agentId;
    return true;
  };

  // Phase 3: Team summary linking
  for (const trace of traces) {
    for (const traceEvent of trace.events) {
      const content = traceEvent.event.message?.content;
      if (typeof content === 'string' && content.includes('<teammate-message>')) {
        // Parse teammate agent IDs from XML blocks
        const matches = content.matchAll(/agent[_-]id['":\s]+([a-f0-9]+)/gi);
        for (const match of matches) {
          const child = traceById.get(match[1]);
          if (child && unresolved(child)) linkHeuristically(trace, child);
        }
      }
    }
  }

  // Phase 4: Positional fallback — timestamp proximity
  // Traces without parents that fall within another trace's time window
  for (const child of traces.filter(unresolved)) {
    if (!child.stats.startTime) continue;
    const childStart = child.stats.startTime.getTime();

    // Find a top-level trace that spawned an agent right before this child started
    for (const potential of traces) {
      if (potential === child || parentOf.has(potential)) continue;

      for (const traceEvent of potential.events) {
        const evt = traceEvent.event;
        if (evt.type === 'assistant' && isSubagentSpawnTool(evt.tool?.name)) {
          const taskTime = new Date(evt.timestamp).getTime();
          // Within 2 seconds before child start
          if (taskTime <= childStart && childStart - taskTime < 2000) {
            linkHeuristically(potential, child);
            break;
          }
        }
      }
      if (parentOf.has(child)) break;
    }
  }

  return traces.filter((trace) => !parentOf.has(trace));
}

/** Ids of the `Agent` / `Task` calls a trace made. */
function spawnToolUseIdsOf(trace: SubagentTrace): string[] {
  const ids: string[] = [];
  for (const traceEvent of trace.events) {
    const content = traceEvent.event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        isSubagentSpawnTool(block.name as string)
      ) {
        ids.push(block.id);
      }
    }
  }
  return ids;
}

// ── Helpers ──

function rawToSessionEvent(raw: Record<string, unknown>): SessionEvent | null {
  const type = raw.type as string;
  if (!type) return null;

  // Map raw JSONL types to SessionEvent types
  const typeMap: Record<string, SessionEvent['type']> = {
    user: 'user',
    assistant: 'assistant',
    tool_use: 'tool_use',
    tool_result: 'tool_result',
    summary: 'summary',
  };

  const mappedType = ownValue(typeMap, type);
  if (!mappedType) return null;

  const message = raw.message as SessionEvent['message'] | undefined;
  const timestamp = (raw.timestamp as string) || new Date().toISOString();

  // Extract tool info for tool_use events from content blocks
  let tool: SessionEvent['tool'];
  let result: SessionEvent['result'];

  if (mappedType === 'assistant' && message?.content && Array.isArray(message.content)) {
    // Look for inline tool_use blocks
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        tool = {
          name: block.name as string,
          input: (block.input as Record<string, unknown>) || {},
        };
        break;
      }
    }
  }

  if (mappedType === 'tool_result') {
    const msg = raw.message as Record<string, unknown> | undefined;
    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          result = {
            tool_use_id: block.tool_use_id as string,
            output: block.content as unknown,
            is_error: block.is_error as boolean | undefined,
          };
          break;
        }
      }
    }
  }

  const common = {
    timestamp,
    isSidechain: raw.isSidechain as boolean | undefined,
    permissionMode: raw.permissionMode as SessionEvent['permissionMode'],
  };
  if (mappedType === 'user' || mappedType === 'assistant') {
    return { ...common, type: mappedType, message: message || { role: 'unknown' }, tool };
  }
  if (mappedType === 'summary') {
    return { ...common, type: 'summary', message: message || { role: 'summary' } };
  }
  if (mappedType === 'tool_use') {
    return tool ? { ...common, type: 'tool_use', message, tool } : null;
  }
  return result ? { ...common, type: 'tool_result', message, result } : null;
}
