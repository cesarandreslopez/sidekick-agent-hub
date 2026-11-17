import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quickPick: null as unknown as Record<string, unknown>,
  searchOverride: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('sidekick-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sidekick-shared')>();
  return {
    ...actual,
    searchSessions: (...args: Parameters<typeof actual.searchSessions>) =>
      mocks.searchOverride ? mocks.searchOverride(...args) : actual.searchSessions(...args),
  };
});

vi.mock('vscode', () => ({
  window: { createQuickPick: () => mocks.quickPick },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (value: string) => value },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

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

describe('CrossSessionSearch status lines', () => {
  function openPicker() {
    let onValue: ((value: string) => void) | undefined;
    const quickPick = {
      placeholder: '',
      items: [] as Array<{ label: string }>,
      selectedItems: [] as unknown[],
      busy: false,
      onDidChangeValue: (handler: (value: string) => void) => {
        onValue = handler;
        return { dispose: vi.fn() };
      },
      onDidAccept: () => ({ dispose: vi.fn() }),
      onDidHide: () => ({ dispose: vi.fn() }),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    mocks.quickPick = quickPick;
    const service = new CrossSessionSearch({
      getSessionPath: () => null,
      getProvider: () => ({ displayName: 'Claude Code' }),
    } as never);
    void service.search();
    return { quickPick, type: (value: string) => onValue!(value) };
  }

  afterEach(() => {
    mocks.searchOverride = null;
  });

  it('shows a failed search as a result line, since the placeholder is hidden while typing', async () => {
    vi.useFakeTimers();
    mocks.searchOverride = async () => {
      throw new Error('EACCES');
    };
    const { quickPick, type } = openPicker();

    type('needle');
    await vi.advanceTimersByTimeAsync(400);

    expect(quickPick.items.map((item) => item.label)).toEqual([
      '$(error) Search failed — View Logs',
    ]);
  });

  it('says how much to type, and when nothing matched', async () => {
    vi.useFakeTimers();
    mocks.searchOverride = async () => [];
    const { quickPick, type } = openPicker();

    type('ne');
    expect(quickPick.items[0]?.label).toBe('$(info) Type 3 or more characters');

    type('needle');
    await vi.advanceTimersByTimeAsync(400);
    expect(quickPick.items[0]?.label).toBe('$(search) No matches for "needle"');
  });
});
