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
  workspace: {
    onDidChangeTextDocument: vi.fn(),
    getWorkspaceFolder: vi.fn((uri: { path: string }) =>
      uri.path.startsWith('/ws/') ? { uri: { path: '/ws' } } : undefined,
    ),
    asRelativePath: vi.fn((uri: { path: string }) => uri.path.replace(/^\/ws\//, '')),
  },
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

describe('KnowledgeNoteDecorationProvider note keys', () => {
  const provider = Object.create(KnowledgeNoteDecorationProvider.prototype) as unknown as {
    getRelativePath(uri: { path: string }): string | undefined;
  };

  it('looks notes up with the same key the store uses', () => {
    // asRelativePath gives forward slashes (and the folder name in multi-root
    // workspaces); path.relative gave backslashes on Windows.
    expect(provider.getRelativePath({ path: '/ws/src/a.ts' })).toBe('src/a.ts');
  });

  it('ignores files outside the workspace', () => {
    expect(provider.getRelativePath({ path: '/elsewhere/a.ts' })).toBeUndefined();
  });
});
