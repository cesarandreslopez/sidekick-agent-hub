/**
 * Small value readers shared by the headless parsers.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module headless/values
 */

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A finite, non-negative number. */
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A line parsed as a JSON object, or `undefined` when it is not one. */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const start = line.trimStart();
  if (!start.startsWith('{')) return undefined;
  try {
    return record(JSON.parse(start));
  } catch {
    return undefined;
  }
}

/** The text of `text` blocks in a content array, joined by newlines. */
export function textOfBlocks(blocks: readonly unknown[]): string {
  const texts: string[] = [];
  for (const value of blocks) {
    const block = record(value);
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n');
}
