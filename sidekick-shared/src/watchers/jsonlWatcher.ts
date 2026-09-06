/**
 * JSONL session watcher for Claude Code and Codex.
 * Uses byte-offset tracking + fs.watch with debounce + catch-up polling.
 */

import { createJsonlTail, type JsonlTail } from './jsonlTail';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { ProviderId } from '../providers/types';
import { normalizeCodexToolName } from '../parsers/codexParser';
import { formatToolSummary } from '../formatters/toolSummary';
import type { FollowEvent, SessionWatcher, SessionWatcherCallbacks } from './types';

// ── Normalizers ──

function normalizeClaudeCodeEvent(raw: RawSessionEvent): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = raw.timestamp || new Date().toISOString();
  const permissionMode = (raw as unknown as Record<string, unknown>).permissionMode as
    | string
    | undefined;
  const usage = raw.message?.usage;
  const tokens = usage
    ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }
    : undefined;
  const cacheTokens =
    usage && (usage.cache_read_input_tokens || usage.cache_creation_input_tokens)
      ? { read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 }
      : undefined;
  const cost = usage?.reported_cost;
  const model = raw.message?.model;

  if (raw.type === 'user') {
    const content = raw.message?.content;
    // Extract tool_result blocks (these carry TaskCreate results, etc.)
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const resultText = typeof block.content === 'string' ? truncate(block.content, 120) : '';
          events.push({
            providerId: 'claude-code',
            type: 'tool_result',
            timestamp: ts,
            summary: resultText || '(tool result)',
            raw: block,
          });
        }
      }
    }
    const text = extractTextContent(content);
    if (text || events.length === 0) {
      events.push({
        providerId: 'claude-code',
        type: 'user',
        timestamp: ts,
        summary: text || '(user message)',
        model,
        raw,
      });
    }
  } else if (raw.type === 'assistant') {
    const content = raw.message?.content;
    // Extract tool_use blocks first
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = block.input
            ? summarizeToolInput(block.name as string, block.input as Record<string, unknown>)
            : '';
          events.push({
            providerId: 'claude-code',
            type: 'tool_use',
            timestamp: ts,
            summary: input ? `${block.name} ${input}` : block.name,
            toolName: block.name,
            toolInput: input,
            model,
            raw: block,
          });
        }
      }
    }
    // Emit the assistant text (if any)
    const text = extractTextContent(content);
    if (text || events.length === 0) {
      events.push({
        providerId: 'claude-code',
        type: 'assistant',
        timestamp: ts,
        summary: text || '(thinking...)',
        tokens,
        cacheTokens,
        cost,
        model,
        raw,
      });
    } else if (tokens) {
      // Attach tokens to the last tool_use event if no separate text
      const last = events[events.length - 1];
      last.tokens = tokens;
      last.cacheTokens = cacheTokens;
      last.cost = cost;
    }
  } else if (raw.type === 'summary') {
    events.push({
      providerId: 'claude-code',
      type: 'summary',
      timestamp: ts,
      summary: 'Context compacted',
      raw,
    });
  } else {
    // system / result events
    if (raw.type === 'result') {
      events.push({
        providerId: 'claude-code',
        type: 'system',
        timestamp: ts,
        summary: 'Session ended',
        raw,
      });
    }
  }

  // Propagate permission mode to all generated events
  if (permissionMode) {
    for (const e of events) {
      e.permissionMode = permissionMode;
    }
  }

  return events;
}

// normalizeCodexEvent is now a method on JsonlSessionWatcher for plan mode state tracking

// ── Helpers ──

function extractTextContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return truncate(content, 200);
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return truncate(block.text, 200);
      }
    }
  }
  return '';
}

function extractPayloadContent(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === 'string') return truncate(content, 200);
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part.text === 'string') return truncate(part.text as string, 200);
    }
  }
  return '';
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  return formatToolSummary(toolName, input);
}

function extractRateLimits(rl: Record<string, unknown>): FollowEvent['rateLimits'] {
  const primary = rl.primary as Record<string, unknown> | undefined;
  const secondary = rl.secondary as Record<string, unknown> | undefined;
  if (!primary && !secondary) return undefined;
  return {
    primary: primary
      ? {
          usedPercent: (primary.used_percent as number) || 0,
          windowMinutes: (primary.window_minutes as number) || 0,
          resetsAt: (primary.resets_at as number) || 0,
        }
      : undefined,
    secondary: secondary
      ? {
          usedPercent: (secondary.used_percent as number) || 0,
          windowMinutes: (secondary.window_minutes as number) || 0,
          resetsAt: (secondary.resets_at as number) || 0,
        }
      : undefined,
  };
}

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
}

// ── Watcher ──

export class JsonlSessionWatcher implements SessionWatcher {
  private tail: JsonlTail | undefined;
  private startOffset: number | undefined;
  private codexInPlanMode = false;

  constructor(
    private readonly providerId: ProviderId,
    private readonly sessionPath: string,
    private readonly callbacks: SessionWatcherCallbacks,
  ) {}

  get isActive(): boolean {
    return this.tail?.isActive ?? false;
  }

  /** Seek to a committed byte offset before starting replay. */
  seekTo(position: number): void {
    this.startOffset = Math.max(0, position);
    this.tail?.seekTo(this.startOffset);
  }

  /** Position after the last complete JSONL line. */
  getPosition(): number {
    return this.tail?.getOffset() ?? this.startOffset ?? 0;
  }

  start(replay: boolean): void {
    if (this.isActive) return;
    this.tail = createJsonlTail<RawSessionEvent>({
      path: this.sessionPath,
      startOffset: replay ? this.getPosition() : undefined,
      startAtEnd: !replay,
      onEvent: (event) => this.handleRawEvent(event),
      onBatchComplete: () => this.callbacks.onBatchComplete?.(),
      onError: (error) => this.callbacks.onError?.(error),
    });
    this.tail.start();
  }

  stop(): void {
    this.tail?.stop();
    this.codexInPlanMode = false;
  }

  private handleRawEvent(event: RawSessionEvent): void {
    // For codex, raw events don't match RawSessionEvent shape exactly, but
    // JsonlParser parses any JSON object. Cast to Record for codex normalizer.
    const followEvents =
      this.providerId === 'codex'
        ? this.normalizeCodexEvent(event as unknown as Record<string, unknown>)
        : normalizeClaudeCodeEvent(event);
    for (const fe of followEvents) {
      this.callbacks.onEvent(fe);
    }
  }

  private normalizeCodexEvent(raw: Record<string, unknown>): FollowEvent[] {
    const events: FollowEvent[] = [];
    const ts = (raw.timestamp as string) || new Date().toISOString();
    const type = raw.type as string;

    if (type === 'session_meta') {
      events.push({
        providerId: 'codex',
        type: 'system',
        timestamp: ts,
        summary: `Session started in ${(raw.payload as Record<string, unknown>)?.cwd || '?'}`,
        raw,
      });
    } else if (type === 'turn_context') {
      const payload = raw.payload as Record<string, unknown> | undefined;
      if (payload?.model) {
        events.push({
          providerId: 'codex',
          type: 'system',
          timestamp: ts,
          summary: `Model: ${payload.model}`,
          model: payload.model as string,
          raw,
        });
      }
    } else if (type === 'response_item') {
      const p = raw.payload as Record<string, unknown>;
      if (!p) return events;
      if (p.role === 'user') {
        const text = extractPayloadContent(p);
        events.push({
          providerId: 'codex',
          type: 'user',
          timestamp: ts,
          summary: text || '(user message)',
          raw,
        });
      } else if (p.role === 'assistant' || p.type === 'message') {
        const text = extractPayloadContent(p);
        events.push({
          providerId: 'codex',
          type: 'assistant',
          timestamp: ts,
          summary: text || '(thinking...)',
          raw,
        });
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const rawName = (p.name as string) || 'unknown';
        const name = normalizeCodexToolName(rawName);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(p.arguments as string);
        } catch {
          /* keep empty */
        }
        const args = typeof p.arguments === 'string' ? truncate(p.arguments, 80) : '';
        events.push({
          providerId: 'codex',
          type: 'tool_use',
          timestamp: ts,
          summary: args ? `${name} ${args}` : name,
          toolName: name,
          toolInput: args,
          raw: { input: parsedArgs },
        });
      } else if (p.type === 'local_shell_call') {
        const cmd = truncate(JSON.stringify(p.command ?? p.arguments ?? ''), 80);
        events.push({
          providerId: 'codex',
          type: 'tool_use',
          timestamp: ts,
          summary: `Bash ${cmd}`,
          toolName: 'Bash',
          toolInput: cmd,
          raw,
        });
      } else if (p.type === 'function_call_output') {
        events.push({
          providerId: 'codex',
          type: 'tool_result',
          timestamp: ts,
          summary: truncate(String(p.output ?? ''), 120),
          raw,
        });
      }
    } else if (type === 'event_msg') {
      const payload = raw.payload as Record<string, unknown> | undefined;
      const evtType = payload?.type as string | undefined;
      if (evtType === 'token_count') {
        const info = payload?.info as Record<string, unknown> | undefined;
        const usage = (info?.last_token_usage || info?.total_token_usage) as
          | Record<string, unknown>
          | undefined;
        const rl = payload?.rate_limits as Record<string, unknown> | undefined;
        const rateLimits = rl ? extractRateLimits(rl) : undefined;
        if (usage || rateLimits) {
          events.push({
            providerId: 'codex',
            type: 'system',
            timestamp: ts,
            summary: usage
              ? `Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`
              : 'Rate limits updated',
            tokens: usage
              ? {
                  input: (usage.input_tokens as number) || 0,
                  output: (usage.output_tokens as number) || 0,
                }
              : undefined,
            rateLimits,
            raw,
          });
        }
      } else if (evtType === 'task_started') {
        const collaboration = payload?.collaboration_mode_kind as string | undefined;
        if (collaboration === 'plan' && !this.codexInPlanMode) {
          this.codexInPlanMode = true;
          events.push({
            providerId: 'codex',
            type: 'tool_use',
            timestamp: ts,
            summary: 'EnterPlanMode',
            toolName: 'EnterPlanMode',
            raw: { input: { source: 'codex_task_started' } },
          });
        }
      } else if (evtType === 'task_complete') {
        if (this.codexInPlanMode) {
          this.codexInPlanMode = false;
          events.push({
            providerId: 'codex',
            type: 'tool_use',
            timestamp: ts,
            summary: 'ExitPlanMode',
            toolName: 'ExitPlanMode',
            raw: { input: { source: 'codex_task_complete' } },
          });
        }
      }
    } else if (type === 'compacted') {
      events.push({
        providerId: 'codex',
        type: 'summary',
        timestamp: ts,
        summary: 'Context compacted',
        raw,
      });
    }

    return events;
  }
}
