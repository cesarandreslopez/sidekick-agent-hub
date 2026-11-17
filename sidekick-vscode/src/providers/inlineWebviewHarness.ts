/**
 * Test-only harness: boots a provider's inline-script webview HTML in a fresh
 * happy-dom window with a stand-in `acquireVsCodeApi`, so tests can drive the
 * real script with host messages and inspect the DOM it renders.
 *
 * It runs in the default node test environment (provider modules import
 * `vscode`, which the happy-dom environment cannot resolve even when mocked).
 * Not imported by any bundle entry; only `*.webview.test.ts` files use it.
 *
 * @module providers/inlineWebviewHarness
 */

import { Window } from 'happy-dom';

export interface BootedWebview {
  window: Window;
  document: Window['document'];
  /** Messages the script posted to the host, in order. */
  posted: Array<{ type: string; [key: string]: unknown }>;
  /** Delivers a host → webview message. */
  send(message: Record<string, unknown>): void;
  /** The state the script last saved with `setState`. */
  getState(): unknown;
  /** Closes the window and cancels its timers. */
  close(): void;
}

/**
 * Renders `html`'s `<head>` styles and `<body>` into a new window, then runs
 * its nonce'd inline scripts in order. `initialState` is what `getState()`
 * returns at boot (the state VS Code restores when a non-retained view is shown
 * again). `beforeScripts` can install globals the page expects (e.g. `d3`).
 */
export function bootInlineWebview(
  html: string,
  initialState?: unknown,
  beforeScripts?: (window: Window) => void,
): BootedWebview {
  const window = new Window({ url: 'https://webview.test/' });
  const document = window.document;

  const headStart = html.indexOf('<head');
  const headEnd = html.indexOf('</head>');
  const styles = [...html.slice(headStart, headEnd).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n');

  const open = html.indexOf('>', html.indexOf('<body')) + 1;
  const bodyHtml = html.slice(open, html.indexOf('</body>'));
  const scriptPattern = /<script nonce="[^"]*"[^>]*>([\s\S]*?)<\/script>/g;
  const scripts = [...bodyHtml.matchAll(scriptPattern)].map((m) => m[1]);

  document.head.innerHTML = `<style>${styles}</style>`;
  document.body.innerHTML = bodyHtml.replace(scriptPattern, '');

  let state = initialState;
  const posted: BootedWebview['posted'] = [];
  (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: { type: string }) => posted.push(message),
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
    },
  });
  // Libraries imported into the test's own Node context (d3-zoom, for one)
  // read the global `navigator`, which Node only defines from version 21.
  // Lend them the window's for as long as this page is open.
  const lentNavigator = typeof (globalThis as { navigator?: unknown }).navigator === 'undefined';
  if (lentNavigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: window.navigator,
      configurable: true,
      writable: true,
    });
  }

  beforeScripts?.(window);

  for (const code of scripts) {
    if (code.trim()) window.eval(code);
  }

  return {
    window,
    document,
    posted,
    send: (message) => window.dispatchEvent(new window.MessageEvent('message', { data: message })),
    getState: () => state,
    close: () => {
      if (lentNavigator) delete (globalThis as { navigator?: unknown }).navigator;
      void window.happyDOM.close();
    },
  };
}

/** A minimal `vscode.Webview` for calling a provider's HTML builder. */
export const fakeWebview = {
  cspSource: 'vscode-resource:',
  asWebviewUri: (uri: unknown) => String(uri),
};
