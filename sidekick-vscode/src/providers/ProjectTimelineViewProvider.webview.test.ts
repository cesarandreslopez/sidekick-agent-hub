/**
 * The Timeline's inline script against its real template: first paint shows
 * loading, refreshes keep focus and don't replay the fade-in, and open cards
 * survive the view being hidden and shown again.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' }, name: 'workspace' }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));

import { ProjectTimelineViewProvider } from './ProjectTimelineViewProvider';
import { bootInlineWebview, fakeWebview } from './inlineWebviewHarness';

const disposable = { dispose: () => undefined };
const monitor = {
  onSessionStart: () => disposable,
  onSessionEnd: () => disposable,
  onTokenUsage: () => disposable,
  getProvider: () => ({}),
  getSessionPath: () => null,
  isActive: () => false,
};

function html(): string {
  const provider = new ProjectTimelineViewProvider({} as never, monitor as never);
  const out = (
    provider as unknown as { _getHtmlForWebview(w: unknown): string }
  )._getHtmlForWebview(fakeWebview);
  provider.dispose();
  return out;
}

function session(id: string) {
  return {
    sessionId: id,
    sessionPath: `/s/${id}`,
    startTime: new Date().toISOString(),
    endTime: null,
    durationMs: 120_000,
    durationLabel: '2m',
    label: `Session ${id}`,
    totalTokens: 1500,
    tokensLabel: '1.5k',
    totalCost: 0,
    messageCount: 3,
    taskCount: 0,
    errorCount: 0,
    keyFiles: [],
    isCurrent: false,
    isActive: false,
    models: [],
    canOpenFile: true,
  };
}

const update = (ids: string[]) => ({
  type: 'updateTimeline',
  state: { sessions: ids.map(session), range: '7d', projectName: 'p', lastUpdated: '' },
});

describe('Timeline webview', () => {
  it('shows loading until the first timeline arrives', () => {
    const view = bootInlineWebview(html());
    const document = view.document;
    const loading = document.getElementById('loading') as unknown as HTMLElement;
    expect(loading.style.display).not.toBe('none');
    view.send(update(['a']));
    expect(loading.style.display).toBe('none');
  });

  it('keeps focus on the same card and only fades cards in on first paint', () => {
    const view = bootInlineWebview(html());
    const document = view.document;
    view.send(update(['a', 'b']));
    expect(document.querySelector('.session-card')!.classList.contains('no-enter-animation')).toBe(
      false,
    );

    const header = document.querySelector('.session-card[data-session-id="b"] .session-header')!;
    (header as unknown as HTMLElement).focus();
    view.send(update(['c', 'a', 'b']));

    const active = document.activeElement!;
    expect(active.classList.contains('session-header')).toBe(true);
    expect(active.closest('.session-card')!.getAttribute('data-session-id')).toBe('b');
    for (const card of document.querySelectorAll('.session-card')) {
      expect(card.classList.contains('no-enter-animation')).toBe(true);
    }
  });

  it('restores open cards after the view is shown again', () => {
    const first = bootInlineWebview(html());
    first.send(update(['a']));
    (first.document.querySelector('.session-header') as unknown as HTMLElement).click();
    expect(first.getState()).toEqual({ openIds: { a: true } });

    const second = bootInlineWebview(html(), first.getState());
    second.send(update(['a']));
    expect(second.document.querySelector('.session-detail')!.classList.contains('visible')).toBe(
      true,
    );
    expect(second.posted).toContainEqual({ type: 'expandSession', sessionId: 'a' });
  });
});
