/**
 * Claude Code writes one API response as several JSONL lines — one per content
 * block — and every line repeats that response's `message.usage`. Streaming
 * also means early lines can carry a partial `output_tokens` (often 1) that a
 * later line of the same `message.id` supersedes. Summing every line
 * therefore roughly doubles a session's tokens and cost.
 *
 * The correct rule is "the last copy of a message's usage wins", but readers
 * stream events and cannot retract what they already emitted. So the first
 * line carries the usage as a normal call, identical repeats are stripped, and
 * a repeat that grew emits only the growth as a `usageKind: 'correction'`
 * top-up. Consumers add corrections to token and cost totals without counting
 * another call or context sample.
 *
 * Browser-safe: no Node imports.
 *
 * @module usage/claudeUsageDedupe
 */

import { normalizeProviderUsage, type NormalizedUsage } from '../usageNormalization';
import type { MessageUsage, SessionEvent } from '../types/sessionEvent';

/** Claude Code's placeholder model for locally generated (unbilled) messages. */
export const SYNTHETIC_MODEL = '<synthetic>';

const DEFAULT_MAX_KEYS = 4096;

/** Attach Anthropic-semantics normalized usage and Claude Code provenance to an event. */
export function normalizeClaudeUsage(event: SessionEvent): SessionEvent {
  const message = event.message;
  const usage = message?.usage;
  if (!message || !usage) {
    return {
      ...event,
      providerMetadata: {
        ...event.providerMetadata,
        providerId: 'claude-code',
        source: 'claude-code-jsonl',
      },
    };
  }
  return {
    ...event,
    message: {
      ...message,
      normalizedUsage: normalizeProviderUsage({
        semantics: 'anthropic',
        provider: 'anthropic',
        source: 'claude-code-jsonl',
        model: message.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        reasoningTokens: usage.reasoning_tokens,
        reasoningIncludedInOutput: false,
        reportedCostUsd: usage.reported_cost,
      }),
    },
    providerMetadata: {
      ...event.providerMetadata,
      providerId: 'claude-code',
      source: 'claude-code-jsonl',
    },
  };
}

/** Tokens a {@link ClaudeUsageDeduper} has already counted for one message id. */
export interface ClaudeUsageDedupeBuckets {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

type Buckets = ClaudeUsageDedupeBuckets;

const BUCKET_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;

/** Entries {@link ClaudeUsageDeduper.exportState} keeps by default. */
const DEFAULT_EXPORT_LIMIT = 256;

/**
 * JSON-serializable state of a {@link ClaudeUsageDeduper}, from
 * `exportState()`, for `importState()` in a reader resumed at the same
 * position (for example from a persisted session snapshot).
 */
export interface ClaudeUsageDedupeState {
  version: 1;
  /** `[message id, counted tokens]` pairs, oldest first. */
  entries: Array<[string, ClaudeUsageDedupeBuckets]>;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function bucketsFrom(value: unknown): Buckets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const buckets = {} as Buckets;
  for (const key of BUCKET_KEYS) {
    const count = record[key];
    if (!isCount(count)) return null;
    buckets[key] = count;
  }
  return buckets;
}

function bucketsOf(usage: NormalizedUsage): Buckets {
  return {
    input: usage.uncachedInputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
  };
}

function stripUsage(event: SessionEvent): SessionEvent {
  if (!event.message) return event;
  const message = { ...event.message };
  delete message.usage;
  delete message.normalizedUsage;
  return { ...event, message } as SessionEvent;
}

/**
 * Per-reader dedupe state. Split lines of one response are adjacent, so a
 * bounded map (oldest keys evicted first) is enough.
 */
export class ClaudeUsageDeduper {
  private readonly seen = new Map<string, Buckets>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  /**
   * Returns the event with its usage adjusted: unchanged for the first line of
   * a message, stripped for an identical repeat or a `<synthetic>` message,
   * and replaced by the growth (marked as a correction) for a repeat that grew.
   * Events must already carry `message.normalizedUsage`.
   */
  apply(event: SessionEvent): SessionEvent {
    const message = event.message;
    const usage = message?.normalizedUsage;
    if (!message || !usage) return event;
    if (message.model === SYNTHETIC_MODEL) return stripUsage(event);

    const id = message.id;
    if (!id) return event;

    const current = bucketsOf(usage);
    const previous = this.seen.get(id);
    if (!previous) {
      this.remember(id, current);
      return event;
    }

    const delta: Buckets = {
      input: Math.max(0, current.input - previous.input),
      cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
      cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
      output: Math.max(0, current.output - previous.output),
      reasoning: Math.max(0, current.reasoning - previous.reasoning),
    };
    this.remember(id, {
      input: previous.input + delta.input,
      cacheRead: previous.cacheRead + delta.cacheRead,
      cacheWrite: previous.cacheWrite + delta.cacheWrite,
      output: previous.output + delta.output,
      reasoning: previous.reasoning + delta.reasoning,
    });

    if (
      !delta.input &&
      !delta.cacheRead &&
      !delta.cacheWrite &&
      !delta.output &&
      !delta.reasoning
    ) {
      return stripUsage(event);
    }

    const cacheInclusiveInputTokens = delta.input + delta.cacheRead + delta.cacheWrite;
    const billableOutputTokens =
      delta.output + (usage.reasoningIncludedInOutput ? 0 : delta.reasoning);
    const normalizedUsage: NormalizedUsage = {
      uncachedInputTokens: delta.input,
      cacheReadTokens: delta.cacheRead,
      cacheWriteTokens: delta.cacheWrite,
      outputTokens: delta.output,
      reasoningTokens: delta.reasoning,
      reasoningIncludedInOutput: usage.reasoningIncludedInOutput,
      cacheInclusiveInputTokens,
      billableOutputTokens,
      totalTokens: cacheInclusiveInputTokens + billableOutputTokens,
      ...(usage.model ? { model: usage.model } : {}),
      provenance: usage.provenance,
    };
    const messageUsage: MessageUsage = {
      input_tokens: delta.input,
      output_tokens: delta.output,
      cache_creation_input_tokens: delta.cacheWrite,
      cache_read_input_tokens: delta.cacheRead,
      ...(delta.reasoning ? { reasoning_tokens: delta.reasoning } : {}),
    };
    return {
      ...event,
      message: { ...message, usage: messageUsage, normalizedUsage, usageKind: 'correction' },
    } as SessionEvent;
  }

  /** Whether a message id has already been counted by this deduper. */
  has(id: string): boolean {
    return this.seen.has(id);
  }

  reset(): void {
    this.seen.clear();
  }

  /**
   * The most recent `limit` message ids and the tokens counted for each,
   * oldest first. Split lines of one response are adjacent, so a reader
   * resumed at the position this was taken at needs only the last few.
   */
  exportState(limit = DEFAULT_EXPORT_LIMIT): ClaudeUsageDedupeState {
    const count = limit >= 0 ? Math.min(this.seen.size, Math.floor(limit)) : 0;
    const entries: Array<[string, Buckets]> = [];
    if (count > 0) {
      let skip = this.seen.size - count;
      for (const [id, buckets] of this.seen) {
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        entries.push([id, { ...buckets }]);
      }
    }
    return { version: 1, entries };
  }

  /**
   * Replaces this deduper's state with one from {@link exportState}. Returns
   * false, changing nothing, when `state` is not a valid version-1 state
   * (wrong shape, empty ids, or counts that are not finite non-negative
   * numbers). Entries beyond this deduper's capacity drop oldest first.
   */
  importState(state: unknown): boolean {
    if (!state || typeof state !== 'object') return false;
    const { version, entries } = state as { version?: unknown; entries?: unknown };
    if (version !== 1 || !Array.isArray(entries)) return false;
    const parsed: Array<[string, Buckets]> = [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [id, value] = entry as [unknown, unknown];
      if (typeof id !== 'string' || id.length === 0) return false;
      const buckets = bucketsFrom(value);
      if (!buckets) return false;
      parsed.push([id, buckets]);
    }
    this.seen.clear();
    for (const [id, buckets] of parsed) this.remember(id, buckets);
    return true;
  }

  private remember(id: string, buckets: Buckets): void {
    this.seen.delete(id);
    this.seen.set(id, buckets);
    if (this.seen.size > this.maxKeys) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/**
 * Deduplicated normalized usage for one raw Claude Code JSONL assistant line,
 * or null when the line carries none (or only repeats usage already counted).
 */
export function dedupedRawClaudeUsage(
  raw: { type?: string; timestamp?: string; message?: SessionEvent['message'] } | null | undefined,
  deduper: ClaudeUsageDeduper,
): NormalizedUsage | null {
  if (!raw || raw.type !== 'assistant' || !raw.message?.usage) return null;
  const event = deduper.apply(
    normalizeClaudeUsage({
      type: 'assistant',
      timestamp: raw.timestamp ?? '',
      message: raw.message,
    } as SessionEvent),
  );
  return event.message?.normalizedUsage ?? null;
}
