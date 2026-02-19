/**
 * @fileoverview Editor decoration provider for knowledge notes.
 *
 * Displays gutter icons and hover tooltips for knowledge notes attached to
 * lines in the active editor. Updates on editor change and file save.
 * On save, triggers staleness check for the saved file.
 *
 * @module providers/KnowledgeNoteDecorationProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { KnowledgeNoteService } from '../services/KnowledgeNoteService';
import type { KnowledgeNote, KnowledgeNoteType } from '../types/knowledgeNote';
import { log } from '../services/Logger';

const NOTE_TYPE_LABELS: Record<KnowledgeNoteType, string> = {
  gotcha: 'Gotcha',
  pattern: 'Pattern',
  guideline: 'Guideline',
  tip: 'Tip',
};

export class KnowledgeNoteDecorationProvider implements vscode.Disposable {
  private decorationTypes: Map<KnowledgeNoteType, vscode.TextEditorDecorationType>;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly knowledgeNoteService: KnowledgeNoteService,
    extensionUri: vscode.Uri,
  ) {
    // Create decoration types with gutter icons
    this.decorationTypes = new Map();
    const types: KnowledgeNoteType[] = ['gotcha', 'pattern', 'guideline', 'tip'];

    for (const noteType of types) {
      const iconPath = vscode.Uri.joinPath(extensionUri, 'images', `note-${noteType}.svg`);
      this.decorationTypes.set(noteType, vscode.window.createTextEditorDecorationType({
        gutterIconPath: iconPath,
        gutterIconSize: 'contain',
      }));
    }

    // Update decorations when active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateDecorations())
    );

    // Update decorations and check staleness on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const relativePath = this.getRelativePath(doc.uri);
        if (relativePath) {
          this.knowledgeNoteService.updateStaleness([relativePath]);
        }
        this.updateDecorations();
      })
    );

    // Update when notes change
    this.disposables.push(
      this.knowledgeNoteService.onDidChange(() => this.updateDecorations())
    );

    // Initial update
    this.updateDecorations();

    log('KnowledgeNoteDecorationProvider initialized');
  }

  private updateDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const relativePath = this.getRelativePath(editor.document.uri);
    if (!relativePath) {
      // Clear all decorations
      for (const decType of this.decorationTypes.values()) {
        editor.setDecorations(decType, []);
      }
      return;
    }

    const notes = this.knowledgeNoteService.getNotesForFile(relativePath);

    // Group decorations by type
    const decorationsByType = new Map<KnowledgeNoteType, vscode.DecorationOptions[]>();
    for (const noteType of this.decorationTypes.keys()) {
      decorationsByType.set(noteType, []);
    }

    for (const note of notes) {
      if (note.status === 'obsolete') continue;

      const decorations = decorationsByType.get(note.noteType);
      if (!decorations) continue;

      const line = note.lineRange ? note.lineRange.start - 1 : 0;
      const safeLine = Math.max(0, Math.min(line, editor.document.lineCount - 1));

      const range = new vscode.Range(safeLine, 0, safeLine, 0);
      const hoverMessage = this.buildHoverMarkdown(note);

      decorations.push({ range, hoverMessage });
    }

    // Apply decorations
    for (const [noteType, decType] of this.decorationTypes) {
      editor.setDecorations(decType, decorationsByType.get(noteType) ?? []);
    }
  }

  private buildHoverMarkdown(note: KnowledgeNote): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const statusBadge = note.status !== 'active' ? ` *(${note.status.replace('_', ' ')})*` : '';
    md.appendMarkdown(`**${NOTE_TYPE_LABELS[note.noteType]}**${statusBadge}\n\n`);

    if (note.title) {
      md.appendMarkdown(`### ${note.title}\n\n`);
    }

    md.appendMarkdown(`${note.content}\n\n`);

    if (note.tags && note.tags.length > 0) {
      md.appendMarkdown(`*Tags: ${note.tags.join(', ')}*\n\n`);
    }

    md.appendMarkdown(`---\n*${note.importance} importance | ${note.source}*`);

    return md;
  }

  private getRelativePath(uri: vscode.Uri): string | undefined {
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!wsFolder) return undefined;
    return path.relative(wsFolder.uri.fsPath, uri.fsPath);
  }

  dispose(): void {
    for (const decType of this.decorationTypes.values()) {
      decType.dispose();
    }
    this.decorationTypes.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    log('KnowledgeNoteDecorationProvider disposed');
  }
}
