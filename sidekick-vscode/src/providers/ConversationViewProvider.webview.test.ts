/**
 * The Conversation panel: a failed open never mislabels or blanks the panel,
 * an empty session says so, and Refresh keeps the search, open rows and scroll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  panel: undefined as
    | undefined
    | {
        title: string;
        webview: {
          html: string;
          cspSource: string;
          postMessage: ReturnType<typeof vi.fn>;
          onDidReceiveMessage: (handler: (m: { type: string }) => void) => void;
        };
        receive?: (m: { type: string }) => void;
      },
  showErrorMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: () => {
      const panel = {
        title: '',
        reveal: vi.fn(),
        onDidDispose: vi.fn(),
        receive: undefined as undefined | ((m: { type: string }) => void),
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          postMessage: vi.fn(),
          onDidReceiveMessage: (handler: (m: { type: string }) => void) => {
            panel.receive = handler;
          },
        },
      };
      h.panel = panel;
      return panel;
    },
    showErrorMessage: h.showErrorMessage,
    showWarningMessage: vi.fn(),
  },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { ConversationViewProvider } from './ConversationViewProvider';
import { bootInlineWebview } from './inlineWebviewHarness';

const userEvent = (text: string, n: number) => ({
  type: 'user',
  timestamp: new Date(Date.UTC(2026, 10, 17, 10, n)).toISOString(),
  message: { role: 'user', content: text },
});

function monitorWith(readers: Record<string, () => unknown[]>) {
  return {
    getSessionPath: () => null,
    getProvider: () => ({
      getSessionId: (p: string) => p.replace(/^.*\//, ''),
      createReader: (p: string) => ({
        readAll: () => {
          const read = readers[p];
          if (!read) throw new Error(`cannot read ${p}`);
          return read();
        },
        flush: () => undefined,
      }),
    }),
  };
}

describe('ConversationViewProvider panel', () => {
  beforeEach(() => {
    h.panel = undefined;
    h.showErrorMessage.mockClear();
  });

  it('a failed first open shows the failure in the panel instead of a blank page', async () => {
    const provider = new ConversationViewProvider({} as never, monitorWith({}) as never);
    await provider.open('/sessions/broken-session');
    expect(h.panel!.webview.html).toContain("Couldn't open this conversation");
    expect(h.panel!.title).not.toContain('broken');
  });

  it('a failed open keeps the session already on screen and its title', async () => {
    const provider = new ConversationViewProvider(
      {} as never,
      monitorWith({ '/sessions/aaaaaaaaaa': () => [userEvent('hello', 1)] }) as never,
    );
    await provider.open('/sessions/aaaaaaaaaa');
    const html = h.panel!.webview.html;
    const title = h.panel!.title;

    await provider.open('/sessions/bbbbbbbbbb');
    expect(h.panel!.title).toBe(title);
    expect(h.panel!.webview.html).toBe(html);
    expect(h.showErrorMessage).toHaveBeenCalled();
  });

  it('says so when the session has no entries yet', async () => {
    const provider = new ConversationViewProvider(
      {} as never,
      monitorWith({ '/sessions/empty': () => [] }) as never,
    );
    await provider.open('/sessions/empty');
    expect(h.panel!.webview.html).toContain('No conversation entries in this session yet.');
  });

  it('Refresh keeps the search query across the page reload', async () => {
    const provider = new ConversationViewProvider(
      {} as never,
      monitorWith({
        '/sessions/aaaaaaaaaa': () => [userEvent('alpha one', 1), userEvent('beta two', 2)],
      }) as never,
    );
    await provider.open('/sessions/aaaaaaaaaa');
    // Times are formatted by the page, in the viewer's zone.
    expect(h.panel!.webview.html).toContain('datetime="2026-11-17T10:01:00.000Z"');

    const first = bootInlineWebview(h.panel!.webview.html);
    const input = first.document.getElementById('search-input') as unknown as HTMLInputElement;
    input.value = 'beta';
    (first.document.getElementById('refresh-btn') as unknown as HTMLElement).click();
    expect(first.posted).toContainEqual({ type: 'refresh' });

    // The host re-renders; the new page restores what the old one saved.
    const second = bootInlineWebview(h.panel!.webview.html, first.getState());
    const restoredInput = second.document.getElementById(
      'search-input',
    ) as unknown as HTMLInputElement;
    expect(restoredInput.value).toBe('beta');
    expect(second.getState()).toBeNull();
    first.close();
    second.close();
  });
});
