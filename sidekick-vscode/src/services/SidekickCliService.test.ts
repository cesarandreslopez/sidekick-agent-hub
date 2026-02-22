/**
 * @fileoverview Unit tests for SidekickCliService.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';

// Mock vscode
const mockCreateTerminal = vi.fn();
const mockShowErrorMessage = vi.fn().mockResolvedValue(undefined);
const mockShowInformationMessage = vi.fn().mockResolvedValue(undefined);
const mockGetConfiguration = vi.fn();
const mockGetExtension = vi.fn();

vi.mock('vscode', () => ({
  default: {},
  window: {
    createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
  },
  workspace: {
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args),
  },
  extensions: {
    getExtension: (...args: unknown[]) => mockGetExtension(...args),
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: (s: string) => s,
  },
}));

const mockExistsSync = vi.fn<(p: unknown) => boolean>().mockReturnValue(false);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (p: unknown) => mockExistsSync(p) };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
}));

import { findSidekickCli, openCliDashboard, disposeDashboardTerminal, checkCliVersion, isNewer } from './SidekickCliService';
import { execSync } from 'child_process';

describe('SidekickCliService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level terminal state by disposing
    disposeDashboardTerminal();

    mockGetConfiguration.mockReturnValue({
      get: vi.fn().mockReturnValue(''),
    });
    mockCreateTerminal.mockReturnValue({
      show: vi.fn(),
      dispose: vi.fn(),
      exitStatus: undefined,
    });
    mockExistsSync.mockReturnValue(false);
  });

  describe('findSidekickCli', () => {
    it('uses configured path when set and exists', () => {
      const configPath = '/custom/bin/sidekick';
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue(configPath),
      });
      mockExistsSync.mockImplementation((p) => p === configPath);

      expect(findSidekickCli()).toBe(configPath);
    });

    it('expands tilde in configured path', () => {
      const home = os.homedir();
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('~/bin/sidekick'),
      });
      mockExistsSync.mockImplementation((p) => p === `${home}/bin/sidekick`);

      expect(findSidekickCli()).toBe(`${home}/bin/sidekick`);
    });

    it('falls through to common paths when config is empty', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue(''),
      });
      const npmGlobal = `${os.homedir()}/.npm-global/bin/sidekick`;
      mockExistsSync.mockImplementation((p) => p === npmGlobal);

      expect(findSidekickCli()).toBe(npmGlobal);
    });

    it('falls through to PATH resolution when no common paths found', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue(''),
      });
      mockExistsSync.mockImplementation((p) => p === '/resolved/sidekick');
      vi.mocked(execSync).mockReturnValue('/resolved/sidekick\n');

      expect(findSidekickCli()).toBe('/resolved/sidekick');
    });

    it('returns null when nothing found', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue(''),
      });
      mockExistsSync.mockReturnValue(false);
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not found');
      });

      expect(findSidekickCli()).toBeNull();
    });

    it('skips configured path if file does not exist', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/missing/sidekick'),
      });
      mockExistsSync.mockReturnValue(false);
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not found');
      });

      expect(findSidekickCli()).toBeNull();
    });
  });

  describe('openCliDashboard', () => {
    it('calls createTerminal with correct args', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);

      openCliDashboard({ workspacePath: '/my/project', providerId: 'claude-code' });

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Sidekick Dashboard',
          shellPath: '/usr/local/bin/sidekick',
          shellArgs: ['dashboard', '--project', '/my/project', '--provider', 'claude-code'],
          env: expect.objectContaining({ PATH: expect.stringContaining('/usr/local/bin') }),
        }),
      );
    });

    it('omits optional args when not provided', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);

      openCliDashboard();

      expect(mockCreateTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Sidekick Dashboard',
          shellPath: '/usr/local/bin/sidekick',
          shellArgs: ['dashboard'],
          env: expect.objectContaining({ PATH: expect.stringContaining('/usr/local/bin') }),
        }),
      );
    });

    it('reuses existing terminal if still alive', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);

      const mockShow = vi.fn();
      mockCreateTerminal.mockReturnValue({
        show: mockShow,
        dispose: vi.fn(),
        exitStatus: undefined,
      });

      // First call creates
      openCliDashboard();
      expect(mockCreateTerminal).toHaveBeenCalledTimes(1);

      // Second call reuses
      openCliDashboard();
      expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
      expect(mockShow).toHaveBeenCalledTimes(2);
    });

    it('creates new terminal if previous one exited', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);

      const exitedTerminal = {
        show: vi.fn(),
        dispose: vi.fn(),
        exitStatus: { code: 0 },
      };
      const freshTerminal = {
        show: vi.fn(),
        dispose: vi.fn(),
        exitStatus: undefined,
      };

      mockCreateTerminal.mockReturnValueOnce(exitedTerminal).mockReturnValueOnce(freshTerminal);

      openCliDashboard();
      expect(mockCreateTerminal).toHaveBeenCalledTimes(1);

      // Second call should create new because first exited
      openCliDashboard();
      expect(mockCreateTerminal).toHaveBeenCalledTimes(2);
    });

    it('shows error notification when CLI not found', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue(''),
      });
      mockExistsSync.mockReturnValue(false);
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not found');
      });

      openCliDashboard();

      expect(mockCreateTerminal).not.toHaveBeenCalled();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        'Sidekick CLI not found. Install sidekick-agent-hub to use the CLI dashboard.',
        'Install in Terminal',
        'Learn More'
      );
    });

    it('shows update notification when CLI version is outdated', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);
      vi.mocked(execSync).mockReturnValue('0.11.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      openCliDashboard();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('v0.11.0 is outdated'),
        'Update Now',
        'Later',
      );
      // Terminal still created (non-blocking)
      expect(mockCreateTerminal).toHaveBeenCalled();
    });

    it('does not show update notification when versions match', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);
      vi.mocked(execSync).mockReturnValue('0.12.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      openCliDashboard();

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    it('only checks version once per session', () => {
      mockGetConfiguration.mockReturnValue({
        get: vi.fn().mockReturnValue('/usr/local/bin/sidekick'),
      });
      mockExistsSync.mockReturnValue(true);
      vi.mocked(execSync).mockReturnValue('0.11.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      const exitedTerminal = {
        show: vi.fn(),
        dispose: vi.fn(),
        exitStatus: { code: 0 },
      };
      mockCreateTerminal.mockReturnValue(exitedTerminal);

      openCliDashboard();
      openCliDashboard();

      // execSync called twice for --version? No — once for version check, findSidekickCli doesn't call it when config path exists
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('isNewer', () => {
    it('returns true when a > b', () => {
      expect(isNewer('1.2.0', '1.1.0')).toBe(true);
      expect(isNewer('2.0.0', '1.9.9')).toBe(true);
      expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    });

    it('returns false when equal', () => {
      expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    });

    it('returns false when a < b', () => {
      expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    });
  });

  describe('checkCliVersion', () => {
    it('returns version info when CLI outputs a version', () => {
      vi.mocked(execSync).mockReturnValue('0.11.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      const result = checkCliVersion('/usr/local/bin/sidekick');

      expect(result).toEqual({
        cliVersion: '0.11.0',
        extensionVersion: '0.12.0',
        needsUpdate: true,
      });
    });

    it('returns needsUpdate false when versions match', () => {
      vi.mocked(execSync).mockReturnValue('0.12.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      const result = checkCliVersion('/usr/local/bin/sidekick');

      expect(result).toEqual({
        cliVersion: '0.12.0',
        extensionVersion: '0.12.0',
        needsUpdate: false,
      });
    });

    it('parses version from prefixed output like "sidekick/0.12.0"', () => {
      vi.mocked(execSync).mockReturnValue('sidekick/0.11.0\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      const result = checkCliVersion('/usr/local/bin/sidekick');

      expect(result?.cliVersion).toBe('0.11.0');
    });

    it('returns null when execSync throws', () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      expect(checkCliVersion('/usr/local/bin/sidekick')).toBeNull();
    });

    it('returns null when output has no version pattern', () => {
      vi.mocked(execSync).mockReturnValue('unknown\n');
      mockGetExtension.mockReturnValue({ packageJSON: { version: '0.12.0' } });

      expect(checkCliVersion('/usr/local/bin/sidekick')).toBeNull();
    });

    it('returns null when extension version is unavailable', () => {
      vi.mocked(execSync).mockReturnValue('0.12.0\n');
      mockGetExtension.mockReturnValue(undefined);

      expect(checkCliVersion('/usr/local/bin/sidekick')).toBeNull();
    });
  });
});
