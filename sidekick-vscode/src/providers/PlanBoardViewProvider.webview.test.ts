/**
 * The Plans board's inline script against its real template: a live update
 * keeps keyboard focus on the same control.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('sidekick-shared', () => ({ readClaudeCodePlanFiles: vi.fn(async () => []) }));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));
vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
  env: { clipboard: { writeText: vi.fn() } },
}));

import { PlanBoardViewProvider } from './PlanBoardViewProvider';
import { bootInlineWebview, fakeWebview } from './inlineWebviewHarness';

const disposable = { dispose: () => undefined };
const monitor = {
  onToolCall: () => disposable,
  onSessionStart: () => disposable,
  onSessionEnd: () => disposable,
  getStats: () => ({ planState: undefined }),
  getStatsView: () => ({ planState: undefined }),
  isActive: () => false,
  getSessionPath: () => null,
  getProvider: () => ({ getSessionId: () => 'session' }),
};

function html(): string {
  const provider = new PlanBoardViewProvider({} as never, monitor as never, undefined);
  const out = (
    provider as unknown as { _getHtmlForWebview(w: unknown): string }
  )._getHtmlForWebview(fakeWebview);
  provider.dispose();
  return out;
}

const plan = (id: string) => ({
  id,
  title: `Plan ${id}`,
  source: 'claude-code',
  status: 'completed',
  createdAt: '2026-11-17T10:00:00Z',
  completionRate: 1,
  steps: [],
  rawMarkdown: '# plan',
});

const update = (ids: string[]) => ({
  type: 'updatePlanBoard',
  state: {
    activePlan: null,
    historicalPlans: ids.map(plan),
    sessionActive: true,
    sessionStatus: 'Live',
  },
});

describe('Plans webview', () => {
  it('keeps focus on the same history header and copy button across updates', () => {
    const view = bootInlineWebview(html());
    const document = view.document;
    view.send(update(['a', 'b']));

    const header = document.querySelector('.collapsible-header[aria-controls="plan-body-b"]')!;
    (header as unknown as HTMLElement).focus();
    view.send(update(['c', 'a', 'b']));
    expect(document.activeElement!.getAttribute('aria-controls')).toBe('plan-body-b');

    (document.querySelector('.copy-btn[data-copy-plan="a"]') as unknown as HTMLElement).focus();
    view.send(update(['d', 'c', 'a', 'b']));
    expect(document.activeElement!.getAttribute('data-copy-plan')).toBe('a');
  });
});
