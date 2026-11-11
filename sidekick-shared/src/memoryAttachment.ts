/**
 * Memory files the agent did not ask for, as `system` session events.
 *
 * Claude Code puts instruction and memory files into context on its own (a
 * nested `CLAUDE.md` when the agent works in a folder that has one) and
 * records each as a `nested_memory` attachment line with the file's path and
 * its full text. With `ExtractSessionEventsOptions.includeActivitySignals`,
 * each becomes one `system` event with `origin: { kind: 'memory-attachment' }`
 * and a single `{ type: 'memory_attachment', path, displayPath?, chars }`
 * content block (read it with {@link memoryAttachmentFromEvent}). The text is
 * never kept: only its path and size.
 *
 * Bookkeeping, not messages: transcripts, context attribution and the
 * aggregator's counts skip these events.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module memoryAttachment
 */

import type { SessionEvent } from './types/sessionEvent';

/** `origin.kind` of a memory-attachment `system` event. */
export const MEMORY_ATTACHMENT_ORIGIN_KIND = 'memory-attachment';

/** `type` of the content block that carries the memory record. */
export const MEMORY_ATTACHMENT_BLOCK_TYPE = 'memory_attachment';

/** Attachment types that put a memory file into context. */
const MEMORY_ATTACHMENT_TYPES: ReadonlySet<string> = new Set(['nested_memory']);

export interface MemoryAttachment {
  /** The attachment type it came from (`nested_memory`). */
  attachment: string;
  /** The file's path as recorded. */
  path: string;
  /** The shorter path Claude Code shows, when recorded. */
  displayPath?: string;
  /** Characters of the file's text; never the text. */
  chars: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textLength(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (depth > 3) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += textLength(item, depth + 1);
    return total;
  }
  const object = record(value);
  if (!object) return 0;
  if (typeof object.text === 'string') return object.text.length;
  if (object.content !== undefined) return textLength(object.content, depth + 1);
  return 0;
}

function pathString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
}

/**
 * The content-free memory record for a Claude Code memory attachment line
 * (`{ type: 'attachment', attachment: { type: 'nested_memory', path, … } }`),
 * or `null` for any other value.
 */
export function memoryAttachmentFromAttachment(raw: unknown): MemoryAttachment | null {
  const line = record(raw);
  if (!line || line.type !== 'attachment') return null;
  const attachment = record(line.attachment);
  if (!attachment || typeof attachment.type !== 'string') return null;
  if (!MEMORY_ATTACHMENT_TYPES.has(attachment.type)) return null;
  const content = record(attachment.content);
  const path = pathString(attachment.path) ?? pathString(content?.path);
  if (!path) return null;
  const memory: MemoryAttachment = {
    attachment: attachment.type,
    path,
    chars: textLength(content ?? attachment.content),
  };
  const displayPath = pathString(attachment.displayPath);
  if (displayPath) memory.displayPath = displayPath;
  return memory;
}

/** Whether an event is a memory-attachment `system` event (see the module docs). */
export function isMemoryAttachmentSystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === MEMORY_ATTACHMENT_ORIGIN_KIND;
}

/** The memory record a memory-attachment `system` event carries; `null` otherwise. */
export function memoryAttachmentFromEvent(event: SessionEvent): MemoryAttachment | null {
  if (!isMemoryAttachmentSystemEvent(event)) return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const raw = record(block);
    if (!raw || raw.type !== MEMORY_ATTACHMENT_BLOCK_TYPE) continue;
    const path = pathString(raw.path);
    if (!path) return null;
    const memory: MemoryAttachment = {
      attachment: typeof raw.attachment === 'string' ? raw.attachment : 'nested_memory',
      path,
      chars: typeof raw.chars === 'number' && raw.chars >= 0 ? Math.round(raw.chars) : 0,
    };
    const displayPath = pathString(raw.displayPath);
    if (displayPath) memory.displayPath = displayPath;
    return memory;
  }
  return null;
}

/** A one-line description naming the file by its last two path parts. */
export function describeMemoryAttachment(memory: MemoryAttachment): string {
  const parts = (memory.displayPath ?? memory.path).split(/[\\/]/).filter(Boolean);
  return `Memory loaded: ${parts.slice(-2).join('/') || memory.path}`;
}
