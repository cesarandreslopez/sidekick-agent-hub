import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above module-level declarations, so the spies it closes
// over have to be created inside vi.hoisted.
const mocks = vi.hoisted(() => {
  const channels: Array<{
    appendLine: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const createOutputChannel = vi.fn(() => {
    const channel = {
      appendLine: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    channels.push(channel);
    return channel;
  });
  const showErrorMessage = vi.fn(() => Promise.resolve<string | undefined>(undefined));
  // Runs the task immediately with a token that is never cancelled.
  const withProgress = vi.fn(
    (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
      task({ report: vi.fn() }, { onCancellationRequested: vi.fn() }),
  );
  const showInformationMessage = vi.fn((..._args: unknown[]) =>
    Promise.resolve<string | undefined>(undefined),
  );
  const showWarningMessage = vi.fn((..._args: unknown[]) =>
    Promise.resolve<string | undefined>(undefined),
  );
  const applyEdit = vi.fn((_edit: unknown) => Promise.resolve(true));
  const replaceCalls: unknown[][] = [];
  class WorkspaceEdit {
    replace(...args: unknown[]) {
      replaceCalls.push(args);
    }
  }
  class Range {
    constructor(
      public start: { line: number; character: number },
      public end: { line: number; character: number },
    ) {}
  }
  return {
    channels,
    createOutputChannel,
    showErrorMessage,
    withProgress,
    showInformationMessage,
    showWarningMessage,
    applyEdit,
    replaceCalls,
    WorkspaceEdit,
    Range,
  };
});

const { channels, createOutputChannel, showErrorMessage } = mocks;

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: mocks.createOutputChannel,
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
    withProgress: mocks.withProgress,
  },
  ProgressLocation: { Notification: 15 },
  env: { clipboard: { writeText: vi.fn() } },
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })), applyEdit: mocks.applyEdit },
  WorkspaceEdit: mocks.WorkspaceEdit,
  Range: mocks.Range,
}));

vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { InlineChatProvider, locateEditRange, type EditTarget } from './InlineChatProvider';
import type { InlineChatService } from '../services/InlineChatService';
import type { InlineChatRequest, InlineChatResult } from '../types/inlineChat';
import { ProviderRequestError } from '../utils/providerFailure';

/** Long enough to take the output-channel branch (threshold is 500 chars). */
const LONG_ANSWER = 'x'.repeat(600);

function makeProvider(): InlineChatProvider {
  return new InlineChatProvider({} as unknown as InlineChatService);
}

/** handleQuestionResponse is private; the leak lives behind it. */
function answer(provider: InlineChatProvider, text: string): Promise<void> {
  return (
    provider as unknown as { handleQuestionResponse(a: string): Promise<void> }
  ).handleQuestionResponse(text);
}

describe('InlineChatProvider output channels', () => {
  beforeEach(() => {
    channels.length = 0;
    createOutputChannel.mockClear();
  });

  it('creates the Quick Ask channel once across repeated invocations', async () => {
    // A fresh channel per invocation left a duplicate entry in the Output
    // dropdown for every Quick Ask, and none were ever disposed.
    const provider = makeProvider();
    await answer(provider, LONG_ANSWER);
    await answer(provider, LONG_ANSWER);
    await answer(provider, LONG_ANSWER);

    expect(createOutputChannel).toHaveBeenCalledTimes(1);
    // A plain channel: a log channel prefixes every answer line with a timestamp and level.
    expect(createOutputChannel).toHaveBeenCalledWith('Sidekick: Quick Ask');
  });

  it('clears the reused channel so answers do not accumulate', async () => {
    const provider = makeProvider();
    await answer(provider, LONG_ANSWER);
    await answer(provider, LONG_ANSWER);

    expect(channels[0].clear).toHaveBeenCalledTimes(2);
    expect(channels[0].appendLine).toHaveBeenCalledTimes(2);
  });

  it('creates no channel for a short answer', async () => {
    const provider = makeProvider();
    await answer(provider, 'brief');
    expect(createOutputChannel).not.toHaveBeenCalled();
  });

  it('disposes the channels it created', () => {
    const provider = makeProvider();
    return answer(provider, LONG_ANSWER).then(() => {
      provider.dispose();
      expect(channels[0].dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('dispose is safe when no channel was ever created', () => {
    const provider = makeProvider();
    expect(() => provider.dispose()).not.toThrow();
  });
});

describe('InlineChatProvider failure retry', () => {
  const request: InlineChatRequest = {
    query: 'explain',
    selectedText: 'const x = 1;',
    languageId: 'typescript',
    contextBefore: '',
    contextAfter: '',
    cursorPosition: { line: 0, character: 0 },
    documentUri: 'file:///tmp/test.ts',
  };

  function run(results: InlineChatResult[]) {
    const process = vi.fn(async () => results.shift() ?? { success: false, error: 'exhausted' });
    const provider = new InlineChatProvider({ process } as unknown as InlineChatService);
    const done = (
      provider as unknown as {
        processWithProgress(editor: unknown, request: InlineChatRequest): Promise<void>;
      }
    ).processWithProgress({}, request);
    return { process, done };
  }

  beforeEach(() => {
    showErrorMessage.mockReset();
    showErrorMessage.mockResolvedValue(undefined);
  });

  it('offers Retry for a retryable failure and re-sends the same request', async () => {
    const cause = new ProviderRequestError({
      provider: 'codex',
      credentialKind: 'oauth',
      error: new Error('Codex error: turn failed', {
        cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
      }),
    });
    showErrorMessage.mockResolvedValueOnce('Retry');
    const { process, done } = run([
      { success: false, error: cause.message, cause },
      { success: false, error: 'Request cancelled' },
    ]);
    await done;

    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).toHaveBeenCalledWith(`Inline chat failed: ${cause.message}`, 'Retry');
    expect(process).toHaveBeenCalledTimes(2);
    expect(process.mock.calls[1]).toEqual([request, expect.any(AbortSignal)]);
  });

  it('shows the plain message when the failure is not retryable', async () => {
    const { process, done } = run([{ success: false, error: 'Request timed out after 5ms' }]);
    await done;

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Inline chat failed: Request timed out after 5ms',
    );
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a cancelled request', async () => {
    const { done } = run([{ success: false, error: 'Request cancelled' }]);
    await done;

    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});

/** Single-line fake document: positions are character offsets on line 0. */
function fakeDocument(text: string, version: number) {
  const pos = (offset: number) => ({ line: 0, character: offset });
  return {
    uri: { toString: () => 'file:///tmp/a.ts' },
    version,
    positionAt: pos,
    getText: (range?: { start: { character: number }; end: { character: number } }) =>
      range ? text.slice(range.start.character, range.end.character) : text,
  };
}

function target(
  doc: ReturnType<typeof fakeDocument>,
  start: number,
  end: number,
  version: number,
): EditTarget {
  return {
    document: doc as unknown as EditTarget['document'],
    range: new mocks.Range({ line: 0, character: start }, { line: 0, character: end }) as never,
    version,
  };
}

describe('locateEditRange', () => {
  it('keeps the captured range when the document is unchanged', () => {
    const doc = fakeDocument('let a = 1; let b = 2;', 3);
    expect(locateEditRange(target(doc, 0, 10, 3), 'let a = 1;')).toMatchObject({
      start: { character: 0 },
      end: { character: 10 },
    });
  });

  it('re-locates the selected text after an edit above it', () => {
    const doc = fakeDocument('// added\nlet a = 1; let b = 2;', 4);
    expect(locateEditRange(target(doc, 0, 10, 3), 'let a = 1;')).toMatchObject({
      start: { character: 9 },
      end: { character: 19 },
    });
  });

  it('refuses when the text is gone, ambiguous, or the request was an insertion', () => {
    expect(locateEditRange(target(fakeDocument('x', 4), 0, 1, 3), 'let a = 1;')).toBeUndefined();
    expect(locateEditRange(target(fakeDocument('ab ab', 4), 3, 5, 3), 'zz')).toBeUndefined();
    expect(locateEditRange(target(fakeDocument('ab ab', 4), 0, 0, 3), '')).toBeUndefined();
  });
});

describe('InlineChatProvider edit placement', () => {
  const request: InlineChatRequest = {
    query: 'rename',
    selectedText: 'let a = 1;',
    languageId: 'typescript',
    contextBefore: '',
    contextAfter: '',
    cursorPosition: { line: 0, character: 0 },
    documentUri: 'file:///tmp/a.ts',
  };

  function respond(provider: InlineChatProvider, editor: unknown, code: string, t: EditTarget) {
    return (
      provider as unknown as {
        handleEditResponse(
          e: unknown,
          r: InlineChatRequest,
          c: string,
          t: EditTarget,
        ): Promise<void>;
      }
    ).handleEditResponse(editor, request, code, t);
  }

  beforeEach(() => {
    mocks.replaceCalls.length = 0;
    mocks.applyEdit.mockClear();
    mocks.applyEdit.mockResolvedValue(true);
    mocks.showInformationMessage.mockReset();
    mocks.showWarningMessage.mockReset();
    mocks.showWarningMessage.mockResolvedValue(undefined);
    showErrorMessage.mockReset();
  });

  it('applies at the range captured with the request, not the current selection', async () => {
    const doc = fakeDocument('let a = 1; let b = 2;', 3);
    // The user moved the cursor to the end while the response was generating.
    const editor = {
      document: doc,
      selection: { start: { line: 0, character: 21 }, end: { line: 0, character: 21 } },
    };
    mocks.showInformationMessage.mockResolvedValueOnce('Apply');
    await respond(makeProvider(), editor, 'let alpha = 1;', target(doc, 0, 10, 3));

    expect(mocks.replaceCalls).toHaveLength(1);
    expect(mocks.replaceCalls[0][1]).toMatchObject({
      start: { character: 0 },
      end: { character: 10 },
    });
    expect(mocks.replaceCalls[0][3]).toBeUndefined();
  });

  it('sends Preview and large edits through the confirmation preview', async () => {
    const doc = fakeDocument('let a = 1; let b = 2;', 3);
    mocks.showInformationMessage.mockResolvedValueOnce('Preview');
    await respond(makeProvider(), { document: doc }, 'let alpha = 1;', target(doc, 0, 10, 3));
    await respond(makeProvider(), { document: doc }, '1\n2\n3\n4\n5\n6', target(doc, 0, 10, 3));

    expect(mocks.replaceCalls).toHaveLength(2);
    for (const call of mocks.replaceCalls) {
      expect(call[3]).toEqual({ needsConfirmation: true, label: 'Sidekick Quick Ask' });
    }
  });

  it('stays quiet when the user discards the preview', async () => {
    const doc = fakeDocument('let a = 1; let b = 2;', 3);
    mocks.applyEdit.mockResolvedValueOnce(false);
    await respond(makeProvider(), { document: doc }, '1\n2\n3\n4\n5\n6', target(doc, 0, 10, 3));
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not apply when the selected text can no longer be found', async () => {
    const doc = fakeDocument('completely different', 9);
    mocks.showInformationMessage.mockResolvedValueOnce('Apply');
    await respond(makeProvider(), { document: doc }, 'let alpha = 1;', target(doc, 0, 10, 3));

    expect(mocks.applyEdit).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('file changed'),
      'Copy Suggestion',
    );
  });
});
