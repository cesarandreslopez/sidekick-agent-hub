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
