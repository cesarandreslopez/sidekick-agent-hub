/**
 * Noise classification pipeline for session events.
 *
 * Multi-layer classification system that filters system noise, sidechains,
 * synthetic messages, and soft noise (system-reminder tags, empty outputs).
 * Inspired by tail-claude's noise filtering.
 *
 * @module formatters/noiseClassifier
 */

import type { SessionEvent } from '../types/sessionEvent';
import type { FollowEvent } from '../watchers/types';

// ── Types ──

export type MessageClassification = 'user' | 'ai' | 'system' | 'teammate' | 'compact';

export interface NoiseResult {
  /** Whether this event should be dropped entirely */
  isHardNoise: boolean;
  /** Reason for soft noise classification, or null if not soft noise */
  softNoiseReason: string | null;
  /** Semantic message classification */
  messageClassification: MessageClassification;
}

// ── Hard Noise Detection ──

/** Hard noise types that should be dropped entirely from display. */
const HARD_NOISE_EVENT_TYPES = new Set([
  'file-history-snapshot',
  'queue-operation',
  'progress',
]);

const SYNTHETIC_MODEL_PREFIX = '<synthetic>';

/**
 * Determines if an event is "hard noise" and should be dropped entirely.
 *
 * Hard noise includes:
 * - System-type events (non-content)
 * - Specific infrastructure event types (file-history-snapshot, queue-operation, progress)
 * - Sidechain/subagent events (when filtering to main conversation)
 * - Synthetic model entries (model starts with `<synthetic>`)
 */
export function isHardNoise(event: SessionEvent): boolean {
  // Sidechain events are noise for the main timeline
  if (event.isSidechain) return true;

  // Check for known noise event types in raw data
  const rawType = (event as unknown as Record<string, unknown>).type as string;
  if (HARD_NOISE_EVENT_TYPES.has(rawType)) return true;

  // Synthetic model entries
  if (event.message?.model?.startsWith(SYNTHETIC_MODEL_PREFIX)) return true;

  return false;
}

/**
 * FollowEvent variant of hard noise detection.
 */
export function isHardNoiseFollowEvent(event: FollowEvent): boolean {
  // System events that are just infrastructure
  if (event.type === 'system') {
    const summary = event.summary?.toLowerCase() ?? '';
    // Keep "Session ended" type system events
    if (summary.includes('session ended') || summary.includes('session started')) {
      return false;
    }
    // Token count events from Codex are noise for timeline display
    if (summary.startsWith('tokens:') || summary.startsWith('model:')) {
      return true;
    }
  }
  return false;
}

// ── Soft Noise Detection ──

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/;
const COMMAND_CAVEAT_PATTERNS = [
  /IMPORTANT:.*?(?:never|always|must|should)/i,
  /Note:.*?(?:do not|don't|avoid)/i,
];
const INTERRUPTION_MARKERS = [
  'interrupted by user',
  'operation cancelled',
  'aborted',
];

/**
 * Checks for soft noise that can be hidden but not dropped.
 *
 * Soft noise includes:
 * - system-reminder XML tags in content
 * - Command caveats (IMPORTANT/Note instructions)
 * - Empty tool outputs
 * - User interruption markers
 *
 * @returns A reason string if soft noise is detected, null otherwise.
 */
export function getSoftNoiseReason(event: SessionEvent): string | null {
  const content = extractContent(event);

  if (content && SYSTEM_REMINDER_PATTERN.test(content)) {
    return 'system-reminder';
  }

  for (const pattern of COMMAND_CAVEAT_PATTERNS) {
    if (content && pattern.test(content)) {
      return 'command-caveat';
    }
  }

  // Empty tool results
  if (event.type === 'tool_result') {
    const output = event.result?.output;
    if (output === '' || output === undefined || output === null) {
      return 'empty-tool-output';
    }
  }

  // Interruption markers
  if (content) {
    for (const marker of INTERRUPTION_MARKERS) {
      if (content.toLowerCase().includes(marker)) {
        return 'interruption';
      }
    }
  }

  return null;
}

// ── Message Classification ──

/**
 * Classifies a SessionEvent into semantic message categories.
 *
 * Categories:
 * - `user` — human prompts
 * - `ai` — assistant responses (text or tool calls)
 * - `system` — tool results, compaction, infrastructure
 * - `teammate` — teammate/subagent messages (from `<teammate-message>` blocks)
 * - `compact` — compaction/summary events
 */
export function classifyMessage(event: SessionEvent): MessageClassification {
  switch (event.type) {
    case 'user': {
      const content = extractContent(event);
      // Check for teammate messages
      if (content && content.includes('<teammate-message>')) {
        return 'teammate';
      }
      return 'user';
    }
    case 'assistant':
      return 'ai';
    case 'summary':
      return 'compact';
    case 'tool_use':
      return 'ai';
    case 'tool_result':
      return 'system';
    default:
      return 'system';
  }
}

/**
 * FollowEvent variant of message classification.
 */
export function classifyFollowEvent(event: FollowEvent): MessageClassification {
  switch (event.type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'ai';
    case 'tool_use':
      return 'ai';
    case 'tool_result':
      return 'system';
    case 'summary':
      return 'compact';
    case 'system':
      return 'system';
    default:
      return 'system';
  }
}

// ── Merge Detection ──

/**
 * Determines if the current event should be merged with the previous one.
 *
 * Consecutive assistant text messages (without tool calls between them)
 * can be merged into a single display entry.
 */
export function shouldMergeWithPrevious(
  current: SessionEvent,
  previous: SessionEvent | null
): boolean {
  if (!previous) return false;

  // Merge consecutive assistant text messages
  if (current.type === 'assistant' && previous.type === 'assistant') {
    // Don't merge if either has tool_use content blocks
    const currentContent = current.message?.content;
    const previousContent = previous.message?.content;
    if (hasToolUseBlocks(currentContent) || hasToolUseBlocks(previousContent)) {
      return false;
    }
    return true;
  }

  return false;
}

// ── Full Classification ──

/**
 * Performs full noise classification on a SessionEvent.
 * Combines hard noise detection, soft noise detection, and message classification.
 */
export function classifyNoise(event: SessionEvent): NoiseResult {
  return {
    isHardNoise: isHardNoise(event),
    softNoiseReason: getSoftNoiseReason(event),
    messageClassification: classifyMessage(event),
  };
}

// ── Helpers ──

function extractContent(event: SessionEvent): string | null {
  const content = event.message?.content;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function hasToolUseBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as Array<Record<string, unknown>>).some(b => b.type === 'tool_use');
}
