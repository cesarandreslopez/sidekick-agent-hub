/**
 * @fileoverview Placing an AI edit after the document may have changed.
 *
 * AI requests take seconds to minutes. Meanwhile the user can move the
 * cursor, switch editors or keep typing, so an edit is placed against what
 * was captured when the request was made, never against the live selection.
 *
 * @module utils/editRange
 */

import * as vscode from 'vscode';

/**
 * Where an edit request was made. Captured before the AI call, because the
 * user can move the cursor or keep typing while the response is generated.
 */
export interface EditTarget {
  document: vscode.TextDocument;
  range: vscode.Range;
  version: number;
}

/**
 * Finds where a suggested edit should land now.
 *
 * Returns the captured range when the document is unchanged, or when the
 * originally selected text is still at that range. Otherwise it re-locates
 * the selected text when it occurs exactly once. Returns `undefined` when the
 * edit can no longer be placed safely (including an insertion point in a
 * document that has since changed).
 */
export function locateEditRange(
  target: EditTarget,
  selectedText: string,
): vscode.Range | undefined {
  const { document } = target;
  if (document.version === target.version) return target.range;
  if (!selectedText) return undefined;
  if (document.getText(target.range) === selectedText) return target.range;
  const text = document.getText();
  const first = text.indexOf(selectedText);
  if (first === -1 || text.indexOf(selectedText, first + 1) !== -1) return undefined;
  return new vscode.Range(
    document.positionAt(first),
    document.positionAt(first + selectedText.length),
  );
}

/**
 * Finds the line an insertion anchored to `anchorText` should use now.
 *
 * `insertLine` was computed when the document was at `version`, relative to
 * `anchorLine` (whose text was `anchorText`, e.g. a function signature).
 * Unchanged document: `insertLine`. Otherwise the anchor is looked up again —
 * at its old line, else the closest line with exactly that text — and the same
 * offset applied. `undefined` when the anchor can't be found.
 */
export function relocateInsertLine(
  document: Pick<vscode.TextDocument, 'version' | 'lineCount' | 'lineAt'>,
  capture: { version: number; anchorLine: number; anchorText: string; insertLine: number },
): number | undefined {
  if (document.version === capture.version) return capture.insertLine;
  const offset = capture.insertLine - capture.anchorLine;
  const textAt = (line: number) =>
    line >= 0 && line < document.lineCount ? document.lineAt(line).text : undefined;
  if (textAt(capture.anchorLine) === capture.anchorText) return capture.insertLine;

  let best: number | undefined;
  for (let line = 0; line < document.lineCount; line++) {
    if (document.lineAt(line).text !== capture.anchorText) continue;
    if (
      best === undefined ||
      Math.abs(line - capture.anchorLine) < Math.abs(best - capture.anchorLine)
    ) {
      best = line;
    }
  }
  return best === undefined ? undefined : best + offset;
}
