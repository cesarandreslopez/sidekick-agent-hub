// @vitest-environment happy-dom
/**
 * The Explain panel bundle: arrow keys move between level tabs without
 * starting a paid request or losing focus, Enter picks a level once, and a
 * cancelled request shows a neutral Cancelled state.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const posted: Array<{ type: string; requestId?: string; complexity?: string }> = [];

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: { type: string }) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  await import('./explain');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'loadCode',
        code: 'const a = 1;',
        fileContext: { fileName: 'a.ts', languageId: 'typescript' },
        complexity: 'senior',
      },
    }),
  );
});

const tabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.complexity-btn'));
const requests = () => posted.filter((m) => m.type === 'requestExplanation');

describe('Explain level tabs', () => {
  it('arrow keys move focus without requesting an explanation', () => {
    const before = requests().length;
    const senior = tabs().find((t) => t.dataset.complexity === 'senior')!;
    senior.focus();
    senior.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(requests()).toHaveLength(before);
    expect((document.activeElement as HTMLElement).dataset.complexity).toBe('phd');
    expect(senior.getAttribute('aria-selected')).toBe('true');
  });

  it('activating a tab requests once and keeps focus on that tab', () => {
    const before = requests().length;
    const phd = tabs().find((t) => t.dataset.complexity === 'phd')!;
    phd.focus();
    phd.click();

    expect(requests()).toHaveLength(before + 1);
    expect(requests().pop()!.complexity).toBe('phd');
    expect(document.activeElement).toBe(phd);
    expect(phd.getAttribute('aria-selected')).toBe('true');
    expect(phd.getAttribute('aria-controls')).toBe('explanation-content');
  });

  it('shows Cancelled, not a failure, for a cancelled request', () => {
    const requestId = requests().pop()!.requestId;
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'explanationCancelled', requestId } }),
    );
    expect(document.getElementById('cancelled-state')!.classList.contains('visible')).toBe(true);
    expect(document.getElementById('error-message')!.classList.contains('visible')).toBe(false);

    document.getElementById('run-again-btn')!.click();
    expect(requests().pop()!.complexity).toBe('phd');
  });
});
