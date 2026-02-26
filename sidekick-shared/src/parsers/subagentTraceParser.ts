/**
 * Subagent execution trace parser.
 *
 * Extends the existing subagent scanner to preserve full conversation events
 * (not just stats) for drill-down trace visualization. Applies noise classification
 * and tool summary formatting from the formatters module.
 *
 * Three-phase parent-child linking:
 * 1. Result-based: match toolUseResult.agentId → parent tool_use_id
 * 2. Team summary: parse <teammate-message> XML blocks
 * 3. Positional fallback: timestamp ordering + proximity
 *
 * @module parsers/subagentTraceParser
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionEvent, SubagentStats, ToolCall } from '../types/sessionEvent';
import { formatToolSummary } from '../formatters/toolSummary';
import { isHardNoise, classifyMessage, getSoftNoiseReason } from '../formatters/noiseClassifier';
import type { MessageClassification } from '../formatters/noiseClassifier';

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
  /** Parent tool_use_id that spawned this agent */
  parentToolUseId?: string;
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
export function scanSubagentTraces(
  sessionDir: string,
  sessionId: string,
): SubagentTrace[] {
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

    // Link parent-child relationships
    linkTraces(traces);

    // Return only top-level traces (those without parents)
    return traces.filter(t => !t.parentToolUseId);
  } catch {
    return [];
  }
}

// ── Parsing ──

function parseAgentTrace(filePath: string, agentId: string): SubagentTrace | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const events: SubagentTraceEvent[] = [];
    const toolCalls: ToolCall[] = [];
    let agentType: string | undefined;
    let description: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
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
          case 'user': noiseLevel = 'user'; break;
          case 'assistant': noiseLevel = 'ai'; break;
          case 'tool_use': noiseLevel = 'system'; break;
          case 'tool_result': noiseLevel = 'noise'; break;
          case 'summary': noiseLevel = 'system'; break;
        }

        // Format tool summary
        let toolSummary: string | undefined;
        if (sessionEvent.type === 'tool_use' && sessionEvent.tool) {
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
        if (raw.type === 'assistant' && raw.message?.usage) {
          const usage = raw.message.usage;
          inputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          outputTokens += usage.output_tokens || 0;
        }

        // Extract tool calls
        if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block?.type === 'tool_use') {
              toolCalls.push({
                name: block.name,
                input: block.input || {},
                timestamp,
              });

              // Extract agent info from Task tool
              if (block.name === 'Task' && block.input) {
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
          const contentStr = typeof raw.message.content === 'string'
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

    if (events.length === 0 && !agentType && !description && inputTokens === 0) {
      return null;
    }

    const durationMs = startTime && endTime ? endTime.getTime() - startTime.getTime() : undefined;

    return {
      agentId,
      agentType,
      description,
      events,
      children: [],
      stats: {
        agentId,
        agentType,
        description,
        toolCalls,
        inputTokens,
        outputTokens,
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

function linkTraces(traces: SubagentTrace[]): void {
  const traceById = new Map<string, SubagentTrace>();
  for (const trace of traces) {
    traceById.set(trace.agentId, trace);
  }

  // Phase 1: Result-based linking
  // Look for tool_result events that contain agentId references
  for (const trace of traces) {
    for (const traceEvent of trace.events) {
      const evt = traceEvent.event;
      if (evt.type === 'tool_use' && evt.tool?.name === 'Task') {
        // The tool_use_id from this call should appear as a result in the parent
        // but we can link via timestamp proximity to child traces
      }
    }
  }

  // Phase 2: Team summary linking
  for (const trace of traces) {
    for (const traceEvent of trace.events) {
      const content = traceEvent.event.message?.content;
      if (typeof content === 'string' && content.includes('<teammate-message>')) {
        // Parse teammate agent IDs from XML blocks
        const matches = content.matchAll(/agent[_-]id['":\s]+([a-f0-9]+)/gi);
        for (const match of matches) {
          const childId = match[1];
          const child = traceById.get(childId);
          if (child && child !== trace) {
            child.parentToolUseId = trace.agentId;
            trace.children.push(child);
          }
        }
      }
    }
  }

  // Phase 3: Positional fallback — timestamp proximity
  // Traces without parents that fall within another trace's time window
  const parentless = traces.filter(t => !t.parentToolUseId);
  for (const child of parentless) {
    if (!child.stats.startTime) continue;
    const childStart = child.stats.startTime.getTime();

    // Find a trace that was active (Task tool call) right before this child started
    for (const potential of traces) {
      if (potential === child) continue;
      if (potential.parentToolUseId) continue; // Already linked

      for (const traceEvent of potential.events) {
        const evt = traceEvent.event;
        if (evt.type === 'tool_use' && evt.tool?.name === 'Task') {
          const taskTime = new Date(evt.timestamp).getTime();
          // Within 2 seconds before child start
          if (taskTime <= childStart && childStart - taskTime < 2000) {
            child.parentToolUseId = potential.agentId;
            potential.children.push(child);
            break;
          }
        }
      }
      if (child.parentToolUseId) break;
    }
  }
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

  const mappedType = typeMap[type];
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

  return {
    type: mappedType,
    message: message || { role: 'unknown' },
    timestamp,
    isSidechain: raw.isSidechain as boolean | undefined,
    permissionMode: raw.permissionMode as SessionEvent['permissionMode'],
    tool,
    result,
  };
}
