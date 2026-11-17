import { beforeEach, describe, expect, it, vi } from 'vitest';

const setStatusBarMessage = vi.hoisted(() => vi.fn());
const progressToken = vi.hoisted(() => ({
  isCancellationRequested: false,
  onCancellationRequested: vi.fn(),
}));

vi.mock('vscode', () => ({
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  ProgressLocation: { Notification: 15 },
  workspace: { getConfiguration: () => ({ get: () => true }) },
  window: {
    setStatusBarMessage,
    withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, progressToken),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  commands: { executeCommand: vi.fn() },
  Range: class {},
  InlineCompletionItem: class {
    constructor(public insertText: string) {}
  },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { InlineCompletionProvider } from './InlineCompletionProvider';

const document = { uri: { scheme: 'file' }, fileName: '/w/a.ts' };
const position = { line: 0, character: 0 };
const token = { isCancellationRequested: false };
const invoke = { triggerKind: 0 };

describe('InlineCompletionProvider', () => {
  beforeEach(() => {
    setStatusBarMessage.mockReset();
    progressToken.isCancellationRequested = false;
  });

  it('stays quiet when the user cancelled from the progress toast', async () => {
    // Cancel in the toast leaves the editor's token untouched.
    const provider = new InlineCompletionProvider({
      getCompletion: vi.fn(async () => {
        progressToken.isCancellationRequested = true;
        return undefined;
      }),
      cancelPending: vi.fn(),
    } as never);

    const items = await provider.provideInlineCompletionItems(
      document as never,
      position as never,
      invoke as never,
      token as never,
    );

    expect(items).toBeUndefined();
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });

  it('says so when a manual request produces no suggestion', async () => {
    const provider = new InlineCompletionProvider({
      getCompletion: vi.fn(async () => undefined),
      cancelPending: vi.fn(),
    } as never);

    const items = await provider.provideInlineCompletionItems(
      document as never,
      position as never,
      invoke as never,
      token as never,
    );

    expect(items).toBeUndefined();
    expect(setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('no suggestion here'),
      3000,
    );
  });

  it('returns the suggestion without a message when there is one', async () => {
    const provider = new InlineCompletionProvider({
      getCompletion: vi.fn(async () => 'return a + b;'),
      cancelPending: vi.fn(),
    } as never);

    const items = await provider.provideInlineCompletionItems(
      document as never,
      position as never,
      invoke as never,
      token as never,
    );

    expect(items).toHaveLength(1);
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });
});
