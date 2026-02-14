/**
 * Strips markdown code fences from a string.
 *
 * Removes opening fences (``` with optional language tag) and closing fences.
 *
 * @param text - The text to strip fences from
 * @returns The text with code fences removed
 */
export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```[\w-]*\s*\n?/gm, '')
    .replace(/\n?\s*```\s*$/gm, '');
}
