import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  receive: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined,
  applyEdit: vi.fn(async (_edit: unknown) => true),
  textDocuments: [] as Array<{ uri: { toString(): string }; version: number }>,
  replaced: [] as Array<{ uri: unknown; text: string }>,
}));
const { posted, applyEdit, textDocuments, replaced } = h;

vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class WorkspaceEdit {
    replace(uri: unknown, _range: unknown, text: string) {
      h.replaced.push({ uri, text });
    }
  }
  return {
    Position,
    Range,
    WorkspaceEdit,
    ViewColumn: { Two: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Uri: { joinPath: () => ({}) },
    window: {
      createWebviewPanel: () => ({
        title: '',
        reveal: vi.fn(),
        dispose: vi.fn(),
        onDidDispose: vi.fn(),
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: () => 'uri',
          postMessage: (message: Record<string, unknown>) => {
            h.posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (handler: typeof h.receive) => {
            h.receive = handler;
          },
        },
      }),
      showInformationMessage: vi.fn(),
    },
    workspace: {
      applyEdit: (edit: unknown) => h.applyEdit(edit),
      textDocuments: h.textDocuments,
    },
  };
});

import { ErrorViewProvider } from './ErrorViewProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const docUri = { toString: () => 'file:///c%3A/repo/a.ts', fsPath: 'C:\\repo\\a.ts' };
const document = {
  uri: docUri,
  version: 3,
  fileName: 'C:\\repo\\a.ts',
  languageId: 'typescript',
  getText: () => 'let x: number = "a";',
};
const diagnostic = {
  message: 'Type string is not assignable to number',
  code: 2322,
  severity: 0,
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 20 } },
};

describe('ErrorViewProvider', () => {
  beforeEach(() => {
    posted.length = 0;
    replaced.length = 0;
    textDocuments.length = 0;
    applyEdit.mockClear();
    h.receive = undefined;
  });

  it('drops a slow earlier result once a newer request has started', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const service = {
      explainError: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    };
    const provider = new ErrorViewProvider({} as never, service as never);

    const a = provider.showErrorExplanation(document as never, diagnostic as never, 'explain');
    const b = provider.showErrorExplanation(document as never, diagnostic as never, 'explain');
    second.resolve({ rootCause: 'B' });
    first.resolve({ rootCause: 'A' });
    await Promise.all([a, b]);

    const results = posted.filter((m) => m.type === 'explanationResult');
    expect(results).toHaveLength(1);
    expect((results[0].explanation as { rootCause: string }).rootCause).toBe('B');
  });

  it('applies a fix to the document URI, once, and refuses a changed document', async () => {
    const service = {
      generateFix: vi.fn(async () => ({
        documentUri: 'C:\\repo\\a.ts',
        range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 20 },
        originalCode: 'x',
        fixedCode: 'let x: string = "a";',
        explanation: 'e',
      })),
    };
    const provider = new ErrorViewProvider({} as never, service as never);
    textDocuments.push({ uri: docUri, version: 3 });

    await provider.showErrorExplanation(document as never, diagnostic as never, 'fix');
    const ready = posted.find((m) => m.type === 'fixReady');
    expect((ready?.fixSuggestion as { documentUri: string }).documentUri).toBe(docUri.toString());

    await h.receive!({ type: 'applyFix' });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(replaced[0].uri).toBe(docUri);

    // A second click must not replace the range again.
    await h.receive!({ type: 'applyFix' });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(posted.filter((m) => m.type === 'applyFixResult').pop()?.success).toBe(false);

    // A new fix for a document edited since then is refused.
    await provider.showErrorExplanation(document as never, diagnostic as never, 'fix');
    textDocuments[0].version = 4;
    await h.receive!({ type: 'applyFix' });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(String(posted.filter((m) => m.type === 'applyFixResult').pop()?.error)).toContain(
      'changed',
    );
  });

  it('reports a cancelled request as cancelled, not as a failure', async () => {
    const controller = new AbortController();
    const service = {
      explainError: vi.fn(
        (_c: unknown, _e: unknown, _x: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ),
    };
    const provider = new ErrorViewProvider({} as never, service as never);
    const run = provider.showErrorExplanation(
      document as never,
      diagnostic as never,
      'explain',
      undefined,
      controller.signal,
    );
    controller.abort();
    await run;
    expect(posted.some((m) => m.type === 'cancelled')).toBe(true);
    expect(posted.some((m) => m.type === 'explanationError')).toBe(false);
  });

  it('reports an AbortError-named rejection as cancelled (toast Cancel, declined retry)', async () => {
    const service = {
      explainError: vi.fn(async () => {
        const err = new Error('Request was cancelled');
        err.name = 'AbortError';
        throw err;
      }),
    };
    const provider = new ErrorViewProvider({} as never, service as never);
    await provider.showErrorExplanation(document as never, diagnostic as never, 'explain');
    expect(posted.some((m) => m.type === 'cancelled')).toBe(true);
    expect(posted.some((m) => m.type === 'explanationError')).toBe(false);
  });

  it("the panel's Cancel aborts the request and shows Cancelled, even if it then finishes", async () => {
    const pending = deferred<unknown>();
    let seenSignal: AbortSignal | undefined;
    const service = {
      generateFix: vi.fn((_c: unknown, _e: unknown, signal: AbortSignal) => {
        seenSignal = signal;
        return pending.promise;
      }),
    };
    const provider = new ErrorViewProvider({} as never, service as never);
    const run = provider.showErrorExplanation(document as never, diagnostic as never, 'fix');

    await h.receive!({ type: 'cancel' });
    expect(seenSignal?.aborted).toBe(true);
    expect(posted.filter((m) => m.type === 'cancelled')).toHaveLength(1);

    pending.resolve({
      documentUri: 'a',
      range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
      originalCode: 'a',
      fixedCode: 'b',
      explanation: 'e',
    });
    await run;
    expect(posted.some((m) => m.type === 'fixReady')).toBe(false);
  });

  it('replays the request and its outcome when the webview reports ready late', async () => {
    const service = { explainError: vi.fn(async () => ({ rootCause: 'R' })) };
    const provider = new ErrorViewProvider({} as never, service as never);
    await provider.showErrorExplanation(document as never, diagnostic as never, 'explain');
    posted.length = 0;

    await h.receive!({ type: 'webviewReady' });
    expect(posted.map((m) => m.type)).toEqual(['loadError', 'explanationResult']);
    expect(posted[0].requestId).toBe(posted[1].requestId);
  });
});
