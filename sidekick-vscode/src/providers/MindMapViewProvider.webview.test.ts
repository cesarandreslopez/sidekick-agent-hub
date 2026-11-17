/**
 * The Mind Map's inline script against its real template and real d3: in the
 * circular layout a live update keeps the zoom and pan the user chose unless
 * Follow is on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d3 from 'd3';

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    dispose(): void {}
  },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));

import { MindMapViewProvider } from './MindMapViewProvider';
import { bootInlineWebview, fakeWebview, type BootedWebview } from './inlineWebviewHarness';

const disposable = { dispose: () => undefined };
const monitor = {
  onTokenUsage: () => disposable,
  onToolCall: () => disposable,
  onSessionStart: () => disposable,
  onSessionEnd: () => disposable,
  isActive: () => false,
  getSessionPath: () => null,
  getProvider: () => ({}),
};

function html(): string {
  const provider = new MindMapViewProvider({} as never, monitor as never);
  const out = (
    provider as unknown as { _getHtmlForWebview(w: unknown): string }
  )._getHtmlForWebview(fakeWebview);
  provider.dispose();
  return out;
}

const graph = (extra: string[]) => ({
  type: 'updateGraph',
  state: {
    sessionActive: true,
    sessionStatus: 'Live',
    lastUpdated: '',
    graph: {
      nodes: [
        { id: 'session', label: 'Session', type: 'session' },
        ...extra.map((id) => ({ id, label: id, type: 'file', fullPath: `/repo/${id}` })),
      ],
      links: extra.map((id) => ({ source: 'session', target: id })),
    },
  },
});

const globals = globalThis as Record<string, unknown>;
let view: BootedWebview | undefined;
let saved: Record<string, unknown> = {};

/** d3 resolves string selectors against the global document. */
function bootWithD3(): BootedWebview {
  const booted = bootInlineWebview(html(), undefined, (win) => {
    saved = {
      document: globals.document,
      window: globals.window,
      SVGElement: globals.SVGElement,
    };
    globals.document = win.document;
    globals.window = win;
    globals.SVGElement = (win as unknown as Record<string, unknown>).SVGElement;
    (win as unknown as Record<string, unknown>).d3 = d3;
    // Reduced motion: d3 transitions become immediate.
    win.document.body.classList.add('vscode-reduce-motion');
  });
  return booted;
}

afterEach(() => {
  view?.close();
  view = undefined;
  globals.document = saved.document;
  globals.window = saved.window;
  globals.SVGElement = saved.SVGElement;
});

describe('Mind Map webview', () => {
  it('keeps the user zoom in circular layout when Follow is off', () => {
    view = bootWithD3();
    const document = view.document;

    view.send(graph(['a.ts', 'b.ts']));

    const svgNode = document.getElementById('graph') as unknown as SVGSVGElement;
    const click = (id: string) => (document.getElementById(id) as unknown as HTMLElement).click();

    click('toggle-layout'); // circular, centred at scale 1
    // While following, a live update re-centres (at scale 1).
    d3.select(svgNode).property('__zoom', d3.zoomIdentity.translate(30, 40).scale(3));
    view.send(graph(['a.ts', 'b.ts', 'x.ts']));
    expect(d3.zoomTransform(svgNode).k).toBe(1);

    click('follow'); // Follow off
    d3.select(svgNode).property('__zoom', d3.zoomIdentity.translate(30, 40).scale(2));

    view.send(graph(['a.ts', 'b.ts', 'c.ts']));
    expect(d3.zoomTransform(svgNode).k).toBe(2);

    click('follow'); // Follow back on: the next update re-centres
    view.send(graph(['a.ts', 'b.ts', 'c.ts', 'd.ts']));
    expect(d3.zoomTransform(svgNode).k).toBe(1);
  });

  it('lays the graph out below a header of any height', () => {
    const source = html();
    expect(source).not.toContain('calc(100vh - 45px)');
    expect(source).toMatch(/#graph-container \{[^}]*flex: 1;/);
  });
});
