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
  return { channels, createOutputChannel };
});

const { channels, createOutputChannel } = mocks;

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: mocks.createOutputChannel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  env: { clipboard: { writeText: vi.fn() } },
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
}));

vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { InlineChatProvider } from './InlineChatProvider';
import type { InlineChatService } from '../services/InlineChatService';

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
    expect(createOutputChannel).toHaveBeenCalledWith('Sidekick: Quick Ask', { log: true });
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
