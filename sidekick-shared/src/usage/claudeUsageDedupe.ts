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

interface Buckets {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
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
