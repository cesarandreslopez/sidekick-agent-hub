import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quickPick: null as unknown as Record<string, unknown>,
}));

vi.mock('vscode', () => ({
  window: { createQuickPick: () => mocks.quickPick },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (value: string) => value },
}));
vi.mock('./Logger', () => ({ log: vi.fn() }));

import { CrossSessionSearch } from './CrossSessionSearch';

afterEach(() => vi.useRealTimers());

describe('CrossSessionSearch', () => {
  it('clears busy state and pending work when the query becomes too short', async () => {
    vi.useFakeTimers();
    let onValue: ((value: string) => void) | undefined;
    let onHide: (() => void) | undefined;
    const dispose = vi.fn();
    const quickPick = {
      placeholder: '',
      matchOnDescription: false,
      matchOnDetail: false,
      items: [] as unknown[],
      selectedItems: [] as unknown[],
      busy: false,
      onDidChangeValue: (handler: (value: string) => void) => {
        onValue = handler;
        return { dispose: vi.fn() };
      },
      onDidAccept: () => ({ dispose: vi.fn() }),
      onDidHide: (handler: () => void) => {
        onHide = handler;
        return { dispose: vi.fn() };
      },
      show: vi.fn(),
      hide: vi.fn(),
      dispose,
    };
    mocks.quickPick = quickPick;
    const findSessionsInDirectory = vi.fn();
    const service = new CrossSessionSearch({
      getSessionPath: () => null,
      getProvider: () => ({
        displayName: 'Claude Code',
        getProjectsBaseDir: () => '/unused',
        findSessionsInDirectory,
      }),
    } as never);
    await service.search();

    onValue!('abcd');
    expect(quickPick.busy).toBe(true);
    onValue!('ab');
    expect(quickPick.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(findSessionsInDirectory).not.toHaveBeenCalled();

    onValue!('another query');
    onHide!();
    await vi.advanceTimersByTimeAsync(500);
    expect(dispose).toHaveBeenCalledOnce();
    expect(findSessionsInDirectory).not.toHaveBeenCalled();
  });
});
