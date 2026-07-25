/**
 * Clamp a detail offset to content that may have shrunk beneath it.
 *
 * The offset survives selection changes so a list churning under the cursor does
 * not throw the reader back to the top, which means it can outlive the content it
 * was measured against — an unclamped slice then renders an empty pane under a
 * "more above" indicator.
 */
export function clampDetailScroll(scrollOffset: number, totalLines: number): number {
  return Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - 1)));
}

/** Maximum detail offset while reserving rows for both scroll indicators. */
export function maxDetailScroll(totalLines: number, viewportHeight: number): number {
  const contentHeight = Math.max(1, viewportHeight - 2);
  return Math.max(0, totalLines - contentHeight);
}

/** Decide whether a bottom-pinned tab needs an initial or incremental jump. */
export function shouldAutoScrollDetail(
  contentKey: string,
  previousContentKey: string | null,
  lineCount: number,
  previousLineCount: number,
): boolean {
  return contentKey !== previousContentKey || lineCount > previousLineCount;
}
