import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectSharedProvider: vi.fn(),
  preference: 'auto',
}));

vi.mock('sidekick-shared', () => ({
  detectProvider: mocks.detectSharedProvider,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => mocks.preference }),
  },
}));

vi.mock('./ClaudeCodeSessionProvider', () => ({
  ClaudeCodeSessionProvider: class ClaudeCodeSessionProvider {},
}));
vi.mock('./OpenCodeSessionProvider', () => ({
  OpenCodeSessionProvider: class OpenCodeSessionProvider {},
}));
vi.mock('./CodexSessionProvider', () => ({
  CodexSessionProvider: class CodexSessionProvider {},
}));
vi.mock('../Logger', () => ({ log: vi.fn() }));

import { detectInferenceProvider, detectProvider } from './ProviderDetector';

describe('ProviderDetector', () => {
  beforeEach(() => {
    mocks.preference = 'auto';
    mocks.detectSharedProvider.mockReset();
  });

  it('delegates configured and automatic session detection to sidekick-shared', () => {
    mocks.preference = 'opencode';
    mocks.detectSharedProvider.mockReturnValue('opencode');

    expect(detectProvider().constructor.name).toBe('OpenCodeSessionProvider');
    expect(mocks.detectSharedProvider).toHaveBeenCalledWith('opencode');
  });

  it('maps the shared Claude provider to Claude Max inference', () => {
    mocks.detectSharedProvider.mockReturnValue('claude-code');

    expect(detectInferenceProvider()).toBe('claude-max');
    expect(mocks.detectSharedProvider).toHaveBeenCalledWith('auto');
  });
});
