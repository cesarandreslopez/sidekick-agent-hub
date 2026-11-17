/**
 * The Kanban board's inline script against its real template: Collapse works
 * in place (no host round trip), names its column and keeps focus, a live
 * update keeps focus too, and chips stay readable in light themes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));

import { TaskBoardViewProvider } from './TaskBoardViewProvider';
import { bootInlineWebview, fakeWebview } from './inlineWebviewHarness';

const disposable = { dispose: () => undefined };
const monitor = {
  onToolCall: () => disposable,
  onSubagentsChanged: () => disposable,
  onSessionStart: () => disposable,
  onSessionEnd: () => disposable,
  isActive: () => false,
  getSessionPath: () => null,
  getProvider: () => ({}),
};

function html(): string {
  const provider = new TaskBoardViewProvider({} as never, monitor as never, undefined);
  const out = (
    provider as unknown as { _getHtmlForWebview(w: unknown): string }
  )._getHtmlForWebview(fakeWebview);
  provider.dispose();
  return out;
}

const task = (taskId: string, status: string) => ({
  taskId,
  subject: `Task ${taskId}`,
  status,
  createdAt: '2026-11-17T10:00:00Z',
  updatedAt: '2026-11-17T10:00:00Z',
  toolCallCount: 1,
  blockedBy: [],
  blocks: [],
});

const board = (pendingIds: string[]) => ({
  type: 'updateBoard',
  state: {
    columns: [
      { status: 'pending', label: 'Pending', tasks: pendingIds.map((id) => task(id, 'pending')) },
      { status: 'in_progress', label: 'In Progress', tasks: [task('9', 'in_progress')] },
      { status: 'completed', label: 'Completed', tasks: [] },
    ],
    sessionActive: true,
    sessionStatus: 'Live',
    lastUpdated: '2026-11-17T10:00:00Z',
    totalTasks: pendingIds.length + 1,
    activeTaskId: null,
    carriedOverCount: 0,
  },
});

describe('Kanban webview', () => {
  it('collapses a column in place, keeping focus and naming the column', () => {
    const view = bootInlineWebview(html());
    const document = view.document;
    view.send(board(['1', '2']));

    const button = document.querySelector('.collapse[data-status="pending"]')!;
    expect(button.getAttribute('aria-label')).toBe('Collapse Pending');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    (button as unknown as HTMLElement).focus();
    const before = view.posted.length;
    (button as unknown as HTMLElement).click();

    expect(view.posted.length).toBe(before); // no requestBoard round trip
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Expand Pending');
    const column = button.closest('.column')!;
    expect(column.classList.contains('collapsed')).toBe(true);
    expect((column.querySelector('.column-body') as unknown as HTMLElement).hidden).toBe(true);
  });

  it('keeps focus on the same Collapse button across a live update', () => {
    const view = bootInlineWebview(html());
    const document = view.document;
    view.send(board(['1']));
    (
      document.querySelector('.collapse[data-status="in_progress"]') as unknown as HTMLElement
    ).focus();

    view.send(board(['1', '2', '3']));

    const active = document.activeElement!;
    expect(active.classList.contains('collapse')).toBe(true);
    expect(active.getAttribute('data-status')).toBe('in_progress');
  });

  it('never puts background-coloured text on a status-coloured fill', () => {
    // Light themes made these 3:1 or worse; the chips and Live pill are outlined.
    const css = html();
    for (const rule of css.match(/[^{}]+\{[^}]*\}/g) ?? []) {
      if (!/\.(chip|status)\b/.test(rule)) continue;
      expect(rule).not.toMatch(/color:\s*var\(--vscode-editor-background\)/);
    }
  });
});
