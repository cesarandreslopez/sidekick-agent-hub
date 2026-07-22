import { describe, expect, it, vi } from 'vitest';

const { MockMarkdownString } = vi.hoisted(() => ({
  MockMarkdownString: class {
    isTrusted: boolean | undefined;
    value = '';

    appendMarkdown(value: string): this {
      this.value += value;
      return this;
    }
  },
}));

vi.mock('vscode', () => ({
  MarkdownString: MockMarkdownString,
  window: { visibleTextEditors: [], onDidChangeVisibleTextEditors: vi.fn() },
  workspace: { onDidChangeTextDocument: vi.fn() },
  Range: class {},
  OverviewRulerLane: { Right: 4 },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { KnowledgeNoteDecorationProvider } from './KnowledgeNoteDecorationProvider';

describe('KnowledgeNoteDecorationProvider', () => {
  it('leaves note hover markdown untrusted', () => {
    const provider = Object.create(KnowledgeNoteDecorationProvider.prototype) as unknown as {
      buildHoverMarkdown(note: unknown): InstanceType<typeof MockMarkdownString>;
    };
    const markdown = provider.buildHoverMarkdown({
      noteType: 'tip',
      status: 'active',
      title: 'Run command',
      content: '[unsafe](command:workbench.action.closeWindow)',
      tags: [],
      importance: 'low',
      source: 'manual',
    });

    expect(markdown.isTrusted).not.toBe(true);
    expect(markdown.value).toContain('command:workbench.action.closeWindow');
  });
});
