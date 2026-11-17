// @vitest-environment happy-dom
/**
 * The Error panel bundle: it opens on the loading state (never "Ready to
 * diagnose" for a request on its way), offers its own Cancel, and words the
 * Fix mode as generating a fix.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const posted: Array<{ type: string }> = [];

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: { type: string }) => posted.push(message),
  });
  await import('./error');
  document.dispatchEvent(new Event('DOMContentLoaded'));
});

const send = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', { data }));

const visible = (id: string) => document.getElementById(id)!.classList.contains('visible');

describe('Error panel webview', () => {
  it('starts on the loading state, not the empty state', () => {
    expect(posted).toContainEqual({ type: 'webviewReady' });
    expect(visible('loading-spinner')).toBe(true);
    expect(visible('empty-state')).toBe(false);
  });

  it('offers a Cancel button while a request runs', () => {
    document.getElementById('cancel-btn')!.click();
    expect(posted).toContainEqual({ type: 'cancel' });
  });

  it('says it is generating a fix in Fix mode, and shows Cancelled', () => {
    send({
      type: 'loadError',
      requestId: 'r1',
      mode: 'fix',
      code: 'x',
      errorContext: {
        fileName: 'a.ts',
        languageId: 'typescript',
        errorMessage: 'bad',
        errorCode: undefined,
        severity: 'error',
        range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
      },
    });
    expect(document.getElementById('loading-text')!.textContent).toBe('Generating fix...');
    expect(document.getElementById('loading-spinner')!.getAttribute('aria-label')).toBe(
      'Generating fix...',
    );

    // Cancel from the panel's own button: focus moves on to Run Again.
    document.getElementById('cancel-btn')!.focus();
    send({ type: 'cancelled', requestId: 'r1' });
    expect(visible('cancelled-state')).toBe(true);
    expect(visible('loading-spinner')).toBe(false);
    expect(document.activeElement?.id).toBe('retry-cancelled-btn');

    send({ type: 'explanationError', requestId: 'r1', error: 'boom' });
    expect(document.getElementById('error-state-title')!.textContent).toBe(
      "Couldn't generate a fix",
    );
  });
});
