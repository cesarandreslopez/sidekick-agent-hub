import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('./TimeoutManager', () => ({
  TimeoutManager: class {},
  getTimeoutManager: () => ({
    getTimeoutConfig: () => ({}),
    executeWithTimeout,
    promptRetry: vi.fn(),
  }),
}));

import { DocumentationService } from './DocumentationService';
import { ProviderRequestError } from '../utils/providerFailure';

const CODE = 'function add(a: number, b: number) {\n  return a + b;\n}';

/** An editor with the function selected from line 0, so no detection runs. */
const editor = {
  document: {
    languageId: 'typescript',
    getText: () => CODE,
    lineAt: (line: number) => ({ text: CODE.split('\n')[line] ?? '' }),
  },
  selection: { isEmpty: false, start: { line: 0 }, active: { line: 0 } },
};

/** Runs the task the way TimeoutManager does: a rejection comes back as `error`. */
async function runTask({ task }: { task: (signal: AbortSignal) => Promise<string> }) {
  try {
    return { success: true, result: await task(new AbortController().signal), timedOut: false };
  } catch (error) {
    return { success: false, error, timedOut: false, timeoutMs: 60_000 };
  }
}

function makeService(complete: () => Promise<string>) {
  const authService = {
    getProviderId: () => 'codex',
    getProviderDisplayName: () => 'Codex',
    complete: vi.fn(complete),
  };
  return new DocumentationService(authService as never);
}

describe('DocumentationService failure cause', () => {
  beforeEach(() => {
    executeWithTimeout.mockReset();
    executeWithTimeout.mockImplementation(runTask);
  });

  it('returns a provider failure as the cause with the unchanged message', async () => {
    const error = new ProviderRequestError({
      provider: 'codex',
      credentialKind: 'oauth',
      error: new Error('Codex error: turn failed', {
        cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
      }),
    });

    const result = await makeService(() => Promise.reject(error)).generateDocumentation(
      editor as never,
    );

    expect(result).toEqual({ error: error.message, cause: error });
  });

  it('sets no cause for timeouts or cancellation', async () => {
    executeWithTimeout.mockResolvedValueOnce({ success: false, timedOut: true, timeoutMs: 5000 });
    const timedOut = await makeService(() => Promise.resolve('')).generateDocumentation(
      editor as never,
    );
    expect(timedOut.error).toMatch(/^Request timed out after 5s/);
    expect(timedOut).not.toHaveProperty('cause');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await makeService(() => Promise.reject(abort)).generateDocumentation(
      editor as never,
    );
    expect(cancelled).toEqual({ cancelled: true });
    expect(cancelled).not.toHaveProperty('cause');
  });
});

describe('DocumentationService Python docstrings', () => {
  beforeEach(() => {
    executeWithTimeout.mockReset();
    executeWithTimeout.mockImplementation(runTask);
  });

  function pythonEditor(code: string, cursorLine: number) {
    const lines = code.split('\n');
    return {
      document: {
        languageId: 'python',
        version: 7,
        lineCount: lines.length,
        getText: () => code,
        lineAt: (line: number) => ({
          text: lines[line] ?? '',
          firstNonWhitespaceCharacterIndex: (lines[line] ?? '').search(/\S|$/),
        }),
      },
      selection: { isEmpty: true, start: { line: cursorLine }, active: { line: cursorLine } },
    };
  }

  it('inserts the docstring inside the body, indented like it', async () => {
    const code = 'import os\n\n\ndef add(a, b):\n    return a + b\n';
    const result = await makeService(async () => '"""Add two numbers."""').generateDocumentation(
      pythonEditor(code, 3) as never,
    );

    expect(result).toMatchObject({
      insertLine: 4,
      documentation: '    """Add two numbers."""\n',
      anchor: { line: 3, text: 'def add(a, b):', version: 7 },
    });
  });

  it('reports an existing body docstring without calling the AI', async () => {
    const complete = vi.fn(async () => '"""x"""');
    const code = 'def add(a, b):\n    """Already here."""\n    return a + b';
    const result = await makeService(complete).generateDocumentation(
      pythonEditor(code, 0) as never,
    );

    expect(result.error).toBe('This definition already has a docstring.');
    expect(executeWithTimeout).not.toHaveBeenCalled();
  });
});
