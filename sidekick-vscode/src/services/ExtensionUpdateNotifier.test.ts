/**
 * @fileoverview Unit tests for ExtensionUpdateNotifier.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockShowInformationMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockExecuteCommand = vi.fn();
const mockOpenExternal = vi.fn();

vi.mock('vscode', () => ({
  default: {},
  window: {
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
  },
  commands: {
    executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
  },
  env: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  },
  Uri: {
    parse: (value: string) => value,
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
  extensions: {
    getExtension: () => undefined,
  },
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import {
  ExtensionUpdateNotifier,
  FIRST_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STATE_KEY,
  parseMarketplaceResponse,
  parseOpenVsxResponse,
  registryForUriScheme,
  type ExtensionRegistry,
  type ExtensionUpdateState,
  type UpdateStateStore,
} from './ExtensionUpdateNotifier';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

class MemoryState implements UpdateStateStore {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  get state(): ExtensionUpdateState | undefined {
    return this.get<ExtensionUpdateState>(UPDATE_STATE_KEY);
  }
}

interface Setup {
  latest?: string;
  fail?: boolean;
  uriScheme?: string;
  enabled?: boolean;
  now?: number;
  state?: ExtensionUpdateState;
  store?: MemoryState;
}

function setup(options: Setup = {}) {
  const store = options.store ?? new MemoryState();
  if (options.state) store.values.set(UPDATE_STATE_KEY, options.state);
  const clock = { now: options.now ?? NOW };
  const fetchLatest = vi.fn(async (_registry: ExtensionRegistry, _signal: AbortSignal) => {
    if (options.fail) throw new Error('offline');
    return options.latest ?? '0.30.1';
  });
  const notifier = new ExtensionUpdateNotifier({
    currentVersion: '0.30.0',
    globalState: store,
    uriScheme: options.uriScheme ?? 'vscode',
    isEnabled: () => options.enabled ?? true,
    now: () => clock.now,
    fetchLatest,
  });
  return { notifier, store, fetchLatest, clock };
}

function updateNotificationCalls(): unknown[][] {
  return mockShowInformationMessage.mock.calls.filter((call) =>
    String(call[0]).includes('is available'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockShowInformationMessage.mockResolvedValue(undefined);
  mockShowWarningMessage.mockResolvedValue(undefined);
  mockExecuteCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registryForUriScheme', () => {
  it('uses the Marketplace for VS Code and VS Code Insiders', () => {
    expect(registryForUriScheme('vscode')).toBe('marketplace');
    expect(registryForUriScheme('vscode-insiders')).toBe('marketplace');
  });

  it.each(['cursor', 'vscodium', 'windsurf', 'code-oss'])('uses Open VSX for %s', (scheme) => {
    expect(registryForUriScheme(scheme)).toBe('openvsx');
  });
});

describe('parseMarketplaceResponse', () => {
  it('returns the newest release version', () => {
    const data = {
      results: [{ extensions: [{ versions: [{ version: '0.30.1' }, { version: '0.30.0' }] }] }],
    };
    expect(parseMarketplaceResponse(data)).toBe('0.30.1');
  });

  it('skips pre-release versions', () => {
    const data = {
      results: [
        {
          extensions: [
            {
              versions: [
                {
                  version: '0.31.0',
                  properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }],
                },
                { version: '0.30.1', properties: [] },
              ],
            },
          ],
        },
      ],
    };
    expect(parseMarketplaceResponse(data)).toBe('0.30.1');
  });

  it('returns null for an empty or malformed response', () => {
    expect(parseMarketplaceResponse({ results: [{ extensions: [] }] })).toBeNull();
    expect(parseMarketplaceResponse(null)).toBeNull();
    expect(parseMarketplaceResponse('nope')).toBeNull();
  });
});

describe('parseOpenVsxResponse', () => {
  it('returns the version', () => {
    expect(parseOpenVsxResponse({ version: '0.30.1' })).toBe('0.30.1');
  });

  it('ignores a pre-release or malformed version', () => {
    expect(parseOpenVsxResponse({ version: '0.31.0', preRelease: true })).toBeNull();
    expect(parseOpenVsxResponse({ version: 'latest' })).toBeNull();
    expect(parseOpenVsxResponse(null)).toBeNull();
  });
});

describe('ExtensionUpdateNotifier automatic checks', () => {
  it('notifies when a newer version is published and records it', async () => {
    const { notifier, store, fetchLatest } = setup();

    await notifier.check({ manual: false });

    expect(fetchLatest).toHaveBeenCalledWith('marketplace', expect.any(AbortSignal));
    expect(updateNotificationCalls()).toHaveLength(1);
    expect(updateNotificationCalls()[0]).toEqual([
      'Sidekick Agent Hub 0.30.1 is available (you have 0.30.0).',
      'Update',
      'Release Notes',
      'Skip This Version',
    ]);
    expect(store.state).toMatchObject({
      latest: '0.30.1',
      registry: 'marketplace',
      checkedAt: NOW,
      notifiedAt: NOW,
      notifiedVersion: '0.30.1',
    });
  });

  it('asks Open VSX in other editors', async () => {
    const { notifier, fetchLatest } = setup({ uriScheme: 'cursor' });

    await notifier.check({ manual: false });

    expect(fetchLatest).toHaveBeenCalledWith('openvsx', expect.any(AbortSignal));
  });

  it('stays quiet when up to date', async () => {
    const { notifier } = setup({ latest: '0.30.0' });

    await notifier.check({ manual: false });

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is off', async () => {
    const { notifier, fetchLatest } = setup({ enabled: false });

    await notifier.check({ manual: false });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('reuses a fresh answer from the same registry without fetching', async () => {
    const { notifier, fetchLatest } = setup({
      state: { latest: '0.30.1', registry: 'marketplace', checkedAt: NOW - HOUR },
    });

    await notifier.check({ manual: false });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(updateNotificationCalls()).toHaveLength(1);
  });

  it('does not reuse an answer cached from the other registry', async () => {
    const { notifier, fetchLatest } = setup({
      uriScheme: 'vscode',
      latest: '0.30.0',
      state: { latest: '0.30.1', registry: 'openvsx', checkedAt: NOW - HOUR },
    });

    await notifier.check({ manual: false });

    expect(fetchLatest).toHaveBeenCalledWith('marketplace', expect.any(AbortSignal));
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('repeats a notification for the same version at most twice a day', async () => {
    const { notifier, clock } = setup();

    await notifier.check({ manual: false });
    clock.now = NOW + HOUR;
    await notifier.check({ manual: false });
    expect(updateNotificationCalls()).toHaveLength(1);

    clock.now = NOW + UPDATE_CHECK_INTERVAL_MS;
    await notifier.check({ manual: false });
    expect(updateNotificationCalls()).toHaveLength(2);
  });

  it('announces a newer version right away', async () => {
    const { notifier } = setup({
      latest: '0.30.2',
      state: { notifiedAt: NOW - HOUR, notifiedVersion: '0.30.1' },
    });

    await notifier.check({ manual: false });

    expect(updateNotificationCalls()[0][0]).toContain('0.30.2 is available');
  });

  it('respects a skipped version', async () => {
    const { notifier } = setup({ state: { skippedVersion: '0.30.1' } });

    await notifier.check({ manual: false });

    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('stamps a failed check and waits out the interval before retrying', async () => {
    const { notifier, store, fetchLatest, clock } = setup({ fail: true });

    await notifier.check({ manual: false });
    expect(store.state).toMatchObject({ registry: 'marketplace', checkedAt: NOW });
    expect(mockShowWarningMessage).not.toHaveBeenCalled();

    clock.now = NOW + HOUR;
    await notifier.check({ manual: false });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('shares one request between overlapping checks', async () => {
    const { notifier, fetchLatest } = setup();

    await Promise.all([notifier.check({ manual: false }), notifier.check({ manual: false })]);

    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });
});

describe('ExtensionUpdateNotifier manual checks', () => {
  it('always asks the registry, even with a fresh answer cached', async () => {
    const { notifier, fetchLatest } = setup({
      state: { latest: '0.30.0', registry: 'marketplace', checkedAt: NOW - HOUR },
    });

    await notifier.check({ manual: true });

    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('reports being up to date', async () => {
    const { notifier } = setup({ latest: '0.30.0' });

    await notifier.check({ manual: true });

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Sidekick Agent Hub is up to date (0.30.0).',
    );
  });

  it('works with the setting off and ignores the skipped version and repeat limit', async () => {
    const { notifier } = setup({
      enabled: false,
      state: { skippedVersion: '0.30.1', notifiedVersion: '0.30.1', notifiedAt: NOW - HOUR },
    });

    await notifier.check({ manual: true });

    expect(updateNotificationCalls()).toHaveLength(1);
  });

  it('reports a failed check', async () => {
    const { notifier } = setup({ fail: true });

    await notifier.check({ manual: true });

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Could not check for Sidekick Agent Hub updates: offline',
    );
  });
});

describe('ExtensionUpdateNotifier notification actions', () => {
  async function choose(choice: string | undefined) {
    mockShowInformationMessage.mockImplementation(async (message: string) =>
      message.includes('is available') ? choice : undefined,
    );
    const { notifier, store } = setup();
    await notifier.check({ manual: false });
    // Let the un-awaited notification handler settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return store;
  }

  it('Update installs the extension by ID and offers a reload', async () => {
    mockShowInformationMessage.mockImplementation(async (message: string) => {
      if (message.includes('is available')) return 'Update';
      if (message.includes('is installed')) return 'Reload Window';
      return undefined;
    });
    const { notifier } = setup();

    await notifier.check({ manual: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'workbench.extensions.installExtension',
      'CesarAndresLopez.sidekick-for-max',
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('Update falls back to the extension page when the install command fails', async () => {
    mockExecuteCommand.mockImplementation(async (command: string) => {
      if (command === 'workbench.extensions.installExtension') throw new Error('no gallery');
    });

    await choose('Update');

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'extension.open',
      'CesarAndresLopez.sidekick-for-max',
    );
  });

  it('Release Notes opens the GitHub release', async () => {
    await choose('Release Notes');

    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://github.com/cesarandreslopez/sidekick-agent-hub/releases/tag/v0.30.1',
    );
  });

  it('Skip This Version stores the version', async () => {
    const store = await choose('Skip This Version');

    expect(store.state?.skippedVersion).toBe('0.30.1');
  });
});

describe('ExtensionUpdateNotifier scheduling', () => {
  it('checks after the startup delay, then every interval, and stops on dispose', async () => {
    vi.useFakeTimers();
    const { notifier, fetchLatest, clock } = setup({ latest: '0.30.0' });

    notifier.start();
    expect(fetchLatest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    clock.now = NOW + UPDATE_CHECK_INTERVAL_MS + FIRST_CHECK_DELAY_MS;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(2);

    notifier.dispose();
    clock.now += UPDATE_CHECK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });
});
