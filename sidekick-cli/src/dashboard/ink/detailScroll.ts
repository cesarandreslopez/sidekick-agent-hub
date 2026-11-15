/**
 * Clamp a detail offset to content that may have shrunk beneath it.
 *
 * The offset survives selection changes so a list churning under the cursor does
 * not throw the reader back to the top, which means it can outlive the content it
 * was measured against — an unclamped slice then renders an empty pane under a
 * "more above" indicator.
 */
export function clampDetailScroll(
  scrollOffset: number,
  totalLines: number,
  viewportHeight?: number,
): number {
  // With a viewport, clamp to the real bottom (the last row visible at the
  // pane's foot) rather than to the last row, which would leave the pane
  // nearly blank under a "more above" indicator.
  const max =
    viewportHeight !== undefined
      ? maxDetailScroll(totalLines, viewportHeight)
      : Math.max(0, totalLines - 1);
  return Math.max(0, Math.min(scrollOffset, max));
}

/** Maximum detail offset while reserving rows for both scroll indicators. */
export function maxDetailScroll(totalLines: number, viewportHeight: number): number {
  const contentHeight = Math.max(1, viewportHeight - 2);
  return Math.max(0, totalLines - contentHeight);
}

/**
 * Decide whether a bottom-pinned tab needs an initial or incremental jump.
 * New content only pulls the view down when the reader was already at the
 * previous bottom; someone who scrolled up to read stays where they are.
 */
export function shouldAutoScrollDetail(
  contentKey: string,
  previousContentKey: string | null,
  lineCount: number,
  previousLineCount: number,
  wasAtBottom = true,
): boolean {
  if (contentKey !== previousContentKey) return true;
  return lineCount > previousLineCount && wasAtBottom;
}
