/**
 * @fileoverview Tree data provider for knowledge notes.
 *
 * Displays a hierarchical tree of knowledge notes grouped by file.
 * Root level: files with notes (grouped by relative path).
 * Children: individual notes per file.
 *
 * @module providers/KnowledgeNoteTreeProvider
 */

import * as vscode from 'vscode';
import type { KnowledgeNoteService } from '../services/KnowledgeNoteService';
import type { KnowledgeNote, KnowledgeNoteType } from '../types/knowledgeNote';
import { log } from '../services/Logger';

export type TreeElement = FileGroupItem | NoteItem;

export interface FileGroupItem {
  kind: 'file';
  filePath: string;
  noteCount: number;
}

export interface NoteItem {
  kind: 'note';
  note: KnowledgeNote;
}

const NOTE_TYPE_ICONS: Record<KnowledgeNoteType, string> = {
  gotcha: 'warning',
  pattern: 'symbol-misc',
  guideline: 'law',
  tip: 'lightbulb',
};

const NOTE_TYPE_LABELS: Record<KnowledgeNoteType, string> = {
  gotcha: 'Gotcha',
  pattern: 'Pattern',
  guideline: 'Guideline',
  tip: 'Tip',
};

const EMPTY_MESSAGE =
  'Capture reusable knowledge — gotchas, patterns, guidelines, tips — attached to files.\n\n' +
  'Notes persist across sessions and can be injected into your instruction file ' +
  '(CLAUDE.md or AGENTS.md) so your AI agent benefits from what you\'ve learned.\n\n' +
  'Select code, then right-click → Add Knowledge Note.';

const POPULATED_MESSAGE =
  'Right-click a note to edit, confirm, or delete. ' +
  'Use "Inject Knowledge Notes" to add them to your instruction file.';

export class KnowledgeNoteTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _treeView: vscode.TreeView<TreeElement> | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly knowledgeNoteService: KnowledgeNoteService) {
    this.disposables.push(
      this.knowledgeNoteService.onDidChange(() => this.refresh())
    );

    log('KnowledgeNoteTreeProvider initialized');
  }

  setTreeView(treeView: vscode.TreeView<TreeElement>): void {
    this._treeView = treeView;
    this._updateMessage();
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        element.filePath,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${element.noteCount} note${element.noteCount !== 1 ? 's' : ''}`;
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'knowledgeNoteFile';
      return item;
    }

    // Note item
    const note = element.note;
    const label = note.title || note.content.slice(0, 60);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.iconPath = new vscode.ThemeIcon(NOTE_TYPE_ICONS[note.noteType]);
    item.description = this.buildDescription(note);
    item.tooltip = this.buildTooltip(note);
    item.id = note.id;

    // Click to navigate to file at line
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) {
      const fileUri = vscode.Uri.joinPath(wsFolder.uri, note.filePath);
      const line = note.lineRange ? note.lineRange.start - 1 : 0;
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [fileUri, { selection: new vscode.Range(line, 0, line, 0) }],
      };
    }

    // Context value enables right-click menu actions
    item.contextValue = 'knowledgeNote';
    return item;
  }

  getChildren(element?: TreeElement): TreeElement[] {
    if (!element) {
      // Root level: files with notes
      const files = this.knowledgeNoteService.getFilesWithNotes();
      return files
        .map(filePath => {
          const notes = this.knowledgeNoteService.getNotesForFile(filePath);
          return { kind: 'file' as const, filePath, noteCount: notes.length };
        })
        .sort((a, b) => a.filePath.localeCompare(b.filePath));
    }

    if (element.kind === 'file') {
      // Children: notes for this file
      const notes = this.knowledgeNoteService.getNotesForFile(element.filePath);
      return notes
        .filter(n => n.status !== 'obsolete')
        .map(note => ({ kind: 'note' as const, note }));
    }

    return [];
  }

  private buildDescription(note: KnowledgeNote): string {
    const parts: string[] = [NOTE_TYPE_LABELS[note.noteType]];

    if (note.status === 'needs_review') {
      parts.push('(needs review)');
    } else if (note.status === 'stale') {
      parts.push('(stale)');
    }

    return parts.join(' ');
  }

  private buildTooltip(note: KnowledgeNote): string {
    const lines: string[] = [];
    lines.push(`${NOTE_TYPE_LABELS[note.noteType]}: ${note.content}`);
    if (note.lineRange) {
      lines.push(`Lines ${note.lineRange.start}-${note.lineRange.end}`);
    }
    lines.push(`Status: ${note.status} | Importance: ${note.importance}`);
    if (note.tags && note.tags.length > 0) {
      lines.push(`Tags: ${note.tags.join(', ')}`);
    }
    return lines.join('\n');
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    this._updateMessage();
  }

  private _updateMessage(): void {
    if (!this._treeView) return;
    const hasNotes = this.knowledgeNoteService.getFilesWithNotes().length > 0;
    this._treeView.message = hasNotes ? POPULATED_MESSAGE : EMPTY_MESSAGE;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    log('KnowledgeNoteTreeProvider disposed');
  }
}
