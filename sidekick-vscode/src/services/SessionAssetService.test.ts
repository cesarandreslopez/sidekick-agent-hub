import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ExtractedAsset, GatherAssetsResult } from 'sidekick-shared';

const {
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockOpenExternal,
  mockWriteText,
  mockOpenTextDocument,
  mockShowTextDocument,
  mockCreateQuickPick,
  quickPickState,
} = vi.hoisted(() => {
  const quickPickState = {
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    items: [] as unknown[],
    selectedItems: [] as unknown[],
    onDidAccept: vi.fn(),
    onDidHide: vi.fn(),
    onDidTriggerItemButton: vi.fn(),
  };

  return {
    mockShowErrorMessage: vi.fn(),
    mockShowInformationMessage: vi.fn(),
    mockOpenExternal: vi.fn(),
    mockWriteText: vi.fn(),
    mockOpenTextDocument: vi.fn(),
    mockShowTextDocument: vi.fn(),
    mockCreateQuickPick: vi.fn(() => quickPickState),
    quickPickState,
  };
});

vi.mock('vscode', () => ({
  default: {},
  QuickPickItemKind: { Separator: -1 },
  ThemeIcon: class {
    constructor(public readonly id: string) {}
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    parse: (value: string) => ({ value, scheme: value.split(':')[0] }),
  },
  Position: class {
    constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  },
  Range: class {
    constructor(
      public readonly start: unknown,
      public readonly end: unknown,
    ) {}
  },
  window: {
    showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showTextDocument: (...args: unknown[]) => mockShowTextDocument(...args),
    createQuickPick: (...args: unknown[]) => mockCreateQuickPick(...args),
  },
  workspace: {
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...args),
  },
  env: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
    clipboard: {
      writeText: (...args: unknown[]) => mockWriteText(...args),
    },
  },
}));

vi.mock('./Logger', () => ({
  logError: vi.fn(),
}));

import {
  buildAssetQuickPickItems,
  resolveAssetAgentsForProvider,
  runAssetDefaultAction,
  showExtractedSessionAssets,
} from './SessionAssetService';

function asset(type: ExtractedAsset['type'], text: string, display = text): ExtractedAsset {
  return { type, text, display, agent: 'codex', sessionPath: '/tmp/session.jsonl' };
}

function assets(overrides: Partial<GatherAssetsResult> = {}): GatherAssetsResult {
  return {
    urls: [],
    paths: [],
    commands: [],
    plans: [],
    inChat: true,
    ...overrides,
  };
}

describe('resolveAssetAgentsForProvider', () => {
  it('maps supported session providers and leaves auto undefined', () => {
    expect(resolveAssetAgentsForProvider('claude-code')).toEqual({ agents: ['claude'] });
    expect(resolveAssetAgentsForProvider('codex')).toEqual({ agents: ['codex'] });
    expect(resolveAssetAgentsForProvider(undefined)).toEqual({ agents: undefined });
  });

  it('reports OpenCode as unsupported', () => {
    expect(resolveAssetAgentsForProvider('opencode')).toEqual({
      agents: [],
      unsupportedProvider: 'opencode',
    });
  });
});

describe('buildAssetQuickPickItems', () => {
  it('creates searchable items with source labels', () => {
    const items = buildAssetQuickPickItems(
      assets({
        urls: [asset('url', 'https://example.test')],
        paths: [asset('path', '/tmp/a.ts:4')],
      }),
    );

    expect(items.map((item) => item.label)).toContain('$(link-external) https://example.test');
    expect(items.map((item) => item.description)).toContain('codex url');
    expect(items.map((item) => item.label)).toContain('$(file-code) /tmp/a.ts:4');
    expect(items.every((item) => item.buttons.length === 1)).toBe(true);
  });
});

describe('runAssetDefaultAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenTextDocument.mockResolvedValue({ uri: 'doc' });
  });

  it('opens URLs externally', async () => {
    await runAssetDefaultAction(asset('url', 'https://example.test'));

    expect(mockOpenExternal).toHaveBeenCalledWith({
      value: 'https://example.test',
      scheme: 'https',
    });
  });

  it('opens file paths at the requested line', async () => {
    await runAssetDefaultAction(asset('path', '/tmp/a.ts:7'));

    expect(mockOpenTextDocument).toHaveBeenCalledWith({ fsPath: '/tmp/a.ts', scheme: 'file' });
    expect(mockShowTextDocument).toHaveBeenCalledWith(
      { uri: 'doc' },
      expect.objectContaining({
        selection: expect.objectContaining({
          start: expect.objectContaining({ line: 6, character: 0 }),
        }),
      }),
    );
  });

  it('copies commands to the clipboard', async () => {
    await runAssetDefaultAction(asset('command', 'npm test'));

    expect(mockWriteText).toHaveBeenCalledWith('npm test');
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Copied command to clipboard.');
  });

  it('opens plans as markdown scratch documents', async () => {
    await runAssetDefaultAction(asset('plan', '# Plan\n- step', 'Plan'));

    expect(mockOpenTextDocument).toHaveBeenCalledWith({
      content: '# Plan\n- step',
      language: 'markdown',
    });
    expect(mockShowTextDocument).toHaveBeenCalledWith({ uri: 'doc' });
  });
});

describe('showExtractedSessionAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quickPickState.items = [];
    quickPickState.selectedItems = [];
  });

  it('requires a workspace path', async () => {
    await showExtractedSessionAssets({ providerId: 'codex', gatherAssets: vi.fn() });

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'Open a workspace folder before extracting session assets.',
    );
  });

  it('does not gather for unsupported providers', async () => {
    const gatherAssets = vi.fn();

    await showExtractedSessionAssets({
      workspacePath: '/project',
      providerId: 'opencode',
      gatherAssets,
    });

    expect(gatherAssets).not.toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      "Session asset extraction supports Claude Code and Codex sessions; provider 'opencode' is not supported yet.",
    );
  });

  it('distinguishes missing sessions from empty sessions', async () => {
    await showExtractedSessionAssets({
      workspacePath: '/project',
      providerId: 'codex',
      gatherAssets: vi.fn(() => assets({ inChat: false })),
    });
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'No recent Claude Code or Codex sessions found for this project.',
    );

    mockShowInformationMessage.mockClear();

    await showExtractedSessionAssets({
      workspacePath: '/project',
      providerId: 'codex',
      gatherAssets: vi.fn(() => assets({ inChat: true })),
    });
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'No extractable assets found in recent sessions.',
    );
  });

  it('shows a QuickPick when assets exist', async () => {
    await showExtractedSessionAssets({
      workspacePath: '/project',
      providerId: 'codex',
      gatherAssets: vi.fn(() => assets({ urls: [asset('url', 'https://example.test')] })),
    });

    expect(mockCreateQuickPick).toHaveBeenCalledOnce();
    expect(quickPickState.items).toHaveLength(1);
    expect(quickPickState.show).toHaveBeenCalledOnce();
  });
});

describe('extension asset command contribution', () => {
  it('declares the native extract command and dashboard title action', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command: string; when?: string }>>;
      };
    };

    expect(manifest.contributes.commands).toContainEqual({
      command: 'sidekick.extractAssets',
      title: 'Sidekick: Extract Session Assets',
      icon: '$(list-tree)',
    });
    expect(manifest.contributes.menus['view/title']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'sidekick.extractAssets',
          when: 'view == sidekick.dashboard',
        }),
      ]),
    );
  });
});
