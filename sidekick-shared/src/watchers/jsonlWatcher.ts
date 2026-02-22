/**
 * JSONL session watcher for Claude Code and Codex.
 * Uses byte-offset tracking + fs.watch with debounce + catch-up polling.
 */

import * as fs from 'fs';
import { JsonlParser } from '../parsers/jsonl';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { ProviderId } from '../providers/types';
import type { FollowEvent, SessionWatcher, SessionWatcherCallbacks } from './types';

const DEBOUNCE_MS = 100;
const CATCHUP_INTERVAL_MS = 30_000;

// ── Normalizers ──

function normalizeClaudeCodeEvent(raw: RawSessionEvent): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = raw.timestamp || new Date().toISOString();
  const usage = raw.message?.usage;
  const tokens = usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } : undefined;
  const cacheTokens = usage && (usage.cache_read_input_tokens || usage.cache_creation_input_tokens)
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
          const resultText = typeof block.content === 'string'
            ? truncate(block.content, 120)
            : '';
          events.push({
            providerId: 'claude-code', type: 'tool_result', timestamp: ts,
            summary: resultText || '(tool result)', raw: block,
          });
        }
      }
    }
    const text = extractTextContent(content);
    if (text || events.length === 0) {
      events.push({
        providerId: 'claude-code', type: 'user', timestamp: ts,
        summary: text || '(user message)', model, raw,
      });
    }
  } else if (raw.type === 'assistant') {
    const content = raw.message?.content;
    // Extract tool_use blocks first
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = block.input ? summarizeToolInput(block.input as Record<string, unknown>) : '';
          events.push({
            providerId: 'claude-code', type: 'tool_use', timestamp: ts,
            summary: input ? `${block.name} ${input}` : block.name,
            toolName: block.name, toolInput: input, model, raw: block,
          });
        }
      }
    }
    // Emit the assistant text (if any)
    const text = extractTextContent(content);
    if (text || events.length === 0) {
      events.push({
        providerId: 'claude-code', type: 'assistant', timestamp: ts,
        summary: text || '(thinking...)', tokens, cacheTokens, cost, model, raw,
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
      providerId: 'claude-code', type: 'summary', timestamp: ts,
      summary: 'Context compacted', raw,
    });
  } else {
    // system / result events
    if (raw.type === 'result') {
      events.push({
        providerId: 'claude-code', type: 'system', timestamp: ts,
        summary: 'Session ended', raw,
      });
    }
  }

  return events;
}

function normalizeCodexEvent(raw: Record<string, unknown>): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = (raw.timestamp as string) || new Date().toISOString();
  const type = raw.type as string;

  if (type === 'session_meta') {
    events.push({
      providerId: 'codex', type: 'system', timestamp: ts,
      summary: `Session started in ${(raw.payload as Record<string, unknown>)?.cwd || '?'}`, raw,
    });
  } else if (type === 'turn_context') {
    const payload = raw.payload as Record<string, unknown> | undefined;
    if (payload?.model) {
      events.push({
        providerId: 'codex', type: 'system', timestamp: ts,
        summary: `Model: ${payload.model}`, model: payload.model as string, raw,
      });
    }
  } else if (type === 'response_item') {
    const p = raw.payload as Record<string, unknown>;
    if (!p) return events;
    if (p.role === 'user') {
      const text = extractPayloadContent(p);
      events.push({
        providerId: 'codex', type: 'user', timestamp: ts,
        summary: text || '(user message)', raw,
      });
    } else if (p.role === 'assistant' || p.type === 'message') {
      const text = extractPayloadContent(p);
      events.push({
        providerId: 'codex', type: 'assistant', timestamp: ts,
        summary: text || '(thinking...)', raw,
      });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = (p.name as string) || 'unknown';
      const args = typeof p.arguments === 'string' ? truncate(p.arguments, 80) : '';
      events.push({
        providerId: 'codex', type: 'tool_use', timestamp: ts,
        summary: args ? `${name} ${args}` : name,
        toolName: name, toolInput: args, raw,
      });
    } else if (p.type === 'local_shell_call') {
      const cmd = truncate(JSON.stringify(p.command ?? p.arguments ?? ''), 80);
      events.push({
        providerId: 'codex', type: 'tool_use', timestamp: ts,
        summary: `Bash ${cmd}`, toolName: 'Bash', toolInput: cmd, raw,
      });
    } else if (p.type === 'function_call_output') {
      events.push({
        providerId: 'codex', type: 'tool_result', timestamp: ts,
        summary: truncate(String(p.output ?? ''), 120), raw,
      });
    }
  } else if (type === 'event_msg') {
    const payload = raw.payload as Record<string, unknown> | undefined;
    const evtType = payload?.type as string | undefined;
    if (evtType === 'token_count') {
      const info = payload?.info as Record<string, unknown> | undefined;
      const usage = (info?.last_token_usage || info?.total_token_usage) as Record<string, unknown> | undefined;
      if (usage) {
        // Extract rate limits if present
        const rl = payload?.rate_limits as Record<string, unknown> | undefined;
        const rateLimits = rl ? extractRateLimits(rl) : undefined;
        events.push({
          providerId: 'codex', type: 'system', timestamp: ts,
          summary: `Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`,
          tokens: { input: (usage.input_tokens as number) || 0, output: (usage.output_tokens as number) || 0 },
          rateLimits,
          raw,
        });
      }
    }
  } else if (type === 'compacted') {
    events.push({
      providerId: 'codex', type: 'summary', timestamp: ts,
      summary: 'Context compacted', raw,
    });
  }

  return events;
}

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

function summarizeToolInput(input: Record<string, unknown>): string {
  // For common tools, extract the most useful field
  if (typeof input.command === 'string') return truncate(input.command, 80);
  if (typeof input.file_path === 'string') return truncate(input.file_path, 80);
  if (typeof input.pattern === 'string') return truncate(input.pattern, 80);
  if (typeof input.query === 'string') return truncate(input.query, 80);
  if (typeof input.path === 'string') return truncate(input.path, 80);
  if (typeof input.url === 'string') return truncate(input.url, 80);
  // Fallback: first string value
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) return truncate(val, 80);
  }
  return '';
}

function extractRateLimits(rl: Record<string, unknown>): FollowEvent['rateLimits'] {
  const primary = rl.primary as Record<string, unknown> | undefined;
  const secondary = rl.secondary as Record<string, unknown> | undefined;
  if (!primary && !secondary) return undefined;
  return {
    primary: primary ? {
      usedPercent: (primary.used_percent as number) || 0,
      windowMinutes: (primary.window_minutes as number) || 0,
      resetsAt: (primary.resets_at as number) || 0,
    } : undefined,
    secondary: secondary ? {
      usedPercent: (secondary.used_percent as number) || 0,
      windowMinutes: (secondary.window_minutes as number) || 0,
      resetsAt: (secondary.resets_at as number) || 0,
    } : undefined,
  };
}

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
}

// ── Watcher ──

export class JsonlSessionWatcher implements SessionWatcher {
  private _isActive = false;
  private filePosition = 0;
  private fsWatcher: fs.FSWatcher | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parser: JsonlParser;
  private readonly providerId: ProviderId;
  private readonly sessionPath: string;
  private readonly callbacks: SessionWatcherCallbacks;

  constructor(providerId: ProviderId, sessionPath: string, callbacks: SessionWatcherCallbacks) {
    this.providerId = providerId;
    this.sessionPath = sessionPath;
    this.callbacks = callbacks;
    this.parser = new JsonlParser({
      onEvent: (event) => this.handleRawEvent(event),
      onError: (err) => callbacks.onError?.(err),
    });
  }

  get isActive(): boolean { return this._isActive; }

  start(replay: boolean): void {
    if (this._isActive) return;
    this._isActive = true;

    if (replay) {
      // Read entire file from offset 0
      this.readNewBytes();
    } else {
      // Skip to end of file
      try {
        const stat = fs.statSync(this.sessionPath);
        this.filePosition = stat.size;
      } catch {
        this.filePosition = 0;
      }
    }

    // Watch for changes
    try {
      this.fsWatcher = fs.watch(this.sessionPath, { persistent: false }, () => {
        this.debouncedRead();
      });
      this.fsWatcher.on('error', () => {
        // File may have been deleted; stop gracefully
        this.stop();
      });
    } catch {
      // fs.watch not available, rely on polling only
    }

    // Catch-up polling
    this.catchupTimer = setInterval(() => {
      if (this._isActive) this.readNewBytes();
    }, CATCHUP_INTERVAL_MS);
  }

  stop(): void {
    if (!this._isActive) return;
    this._isActive = false;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.fsWatcher) { this.fsWatcher.close(); this.fsWatcher = null; }
    if (this.catchupTimer) { clearInterval(this.catchupTimer); this.catchupTimer = null; }

    this.parser.flush();
  }

  private debouncedRead(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.readNewBytes();
    }, DEBOUNCE_MS);
  }

  private readNewBytes(): void {
    if (!this._isActive) return;
    let fd: number | null = null;
    try {
      const stat = fs.statSync(this.sessionPath);

      // Handle file truncation (shouldn't happen with append-only, but be safe)
      if (stat.size < this.filePosition) {
        this.filePosition = 0;
        this.parser.reset();
      }

      if (stat.size <= this.filePosition) return;

      fd = fs.openSync(this.sessionPath, 'r');
      const bytesToRead = stat.size - this.filePosition;
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.filePosition);
      fs.closeSync(fd);
      fd = null;

      if (bytesRead > 0) {
        this.filePosition += bytesRead;
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        this.parser.processChunk(chunk);
      }
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleRawEvent(event: RawSessionEvent): void {
    // For codex, raw events don't match RawSessionEvent shape exactly, but
    // JsonlParser parses any JSON object. Cast to Record for codex normalizer.
    const followEvents = this.providerId === 'codex'
      ? normalizeCodexEvent(event as unknown as Record<string, unknown>)
      : normalizeClaudeCodeEvent(event);
    for (const fe of followEvents) {
      this.callbacks.onEvent(fe);
    }
  }
}
