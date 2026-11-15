/**
 * @fileoverview Finds the diagnostic an error command should act on.
 *
 * The lightbulb code action passes `(uri, diagnostic)`, but editor context
 * menus pass only the document URI. Error commands use this resolver so a
 * missing diagnostic is looked up at the selection instead of throwing.
 *
 * @module utils/diagnosticAtSelection
 */

import * as vscode from 'vscode';

/** Minimal position shape so the pure helpers can be unit-tested. */
interface PositionLike {
  line: number;
  character: number;
}

/** Minimal range shape so the pure helpers can be unit-tested. */
interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

/** Minimal diagnostic shape used by {@link pickDiagnosticsAt}. */
export interface DiagnosticLike {
  range: RangeLike;
  severity: number;
  message: string;
}

function comparePositions(a: PositionLike, b: PositionLike): number {
  return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

/** True when two ranges share at least one position (inclusive ends). */
export function rangesOverlap(a: RangeLike, b: RangeLike): boolean {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}

/**
 * Returns the errors and warnings that overlap `target`, errors first, then
 * by position. Information and hint diagnostics are ignored.
 *
 * Severity values follow `vscode.DiagnosticSeverity` (Error = 0, Warning = 1).
 */
export function pickDiagnosticsAt<T extends DiagnosticLike>(
  diagnostics: readonly T[],
  target: RangeLike,
): T[] {
  return diagnostics
    .filter((d) => d.severity <= 1 && rangesOverlap(d.range, target))
    .sort((a, b) => a.severity - b.severity || comparePositions(a.range.start, b.range.start));
}

/**
 * Resolves the diagnostic an error command should explain or fix.
 *
 * Returns the passed diagnostic when there is one. Otherwise it looks up the
 * errors and warnings at the editor's selection (or the cursor line when the
 * selection is empty), asks the user to choose when there are several, and
 * shows a message and returns `undefined` when there are none.
 */
export async function resolveDiagnosticAtSelection(
  uri: vscode.Uri | undefined,
  diagnostic: vscode.Diagnostic | undefined,
): Promise<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic } | undefined> {
  const editor =
    (uri &&
      [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
        (e) => e?.document.uri.toString() === uri.toString(),
      )) ||
    vscode.window.activeTextEditor;
  const targetUri = uri ?? editor?.document.uri;
  if (!targetUri) {
    vscode.window.showInformationMessage('Open a file with an error or warning first.');
    return undefined;
  }
  if (diagnostic) return { uri: targetUri, diagnostic };

  let target: RangeLike | undefined;
  if (editor && editor.document.uri.toString() === targetUri.toString()) {
    const selection = editor.selection;
    target = selection.isEmpty ? editor.document.lineAt(selection.active.line).range : selection;
  }
  if (!target) {
    vscode.window.showInformationMessage('Put the cursor on an error or warning first.');
    return undefined;
  }

  const candidates = pickDiagnosticsAt(vscode.languages.getDiagnostics(targetUri), target);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage('No error or warning at the selection.');
    return undefined;
  }
  if (candidates.length === 1) return { uri: targetUri, diagnostic: candidates[0] };

  const picked = await vscode.window.showQuickPick(
    candidates.map((d) => ({
      label: `${d.severity === vscode.DiagnosticSeverity.Error ? '$(error)' : '$(warning)'} ${d.message.split('\n')[0]}`,
      description: `Ln ${d.range.start.line + 1}, Col ${d.range.start.character + 1}`,
      diagnostic: d,
    })),
    { placeHolder: 'Several problems at the selection — choose one' },
  );
  return picked ? { uri: targetUri, diagnostic: picked.diagnostic } : undefined;
}
