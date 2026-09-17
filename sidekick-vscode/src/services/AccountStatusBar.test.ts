import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from 'sidekick-shared';

const { MockEventEmitter, MockMarkdownString, MockThemeColor, statusBarItems } = vi.hoisted(() => ({
  MockEventEmitter: class<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  MockMarkdownString: class {
    value = '';
    isTrusted: boolean | undefined;
    appendMarkdown(text: string): this {
      this.value += text;
      return this;
    }
  },
  MockThemeColor: class {
    constructor(public id: string) {}
  },
  statusBarItems: [] as Array<Record<string, unknown>>,
}));

vi.mock('vscode', () => ({
  EventEmitter: MockEventEmitter,
  MarkdownString: MockMarkdownString,
  ThemeColor: MockThemeColor,
  StatusBarAlignment: { Right: 2 },
  window: {
    createStatusBarItem: vi.fn(() => {
      const item = {
        text: '',
        tooltip: undefined as unknown,
        command: undefined as unknown,
        backgroundColor: undefined as unknown,
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose: vi.fn(),
      };
      statusBarItems.push(item);
      return item;
    }),
  },
  workspace: { onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })) },
}));

import { AccountStatusBar } from './AccountStatusBar';
import type { AccountService } from './AccountService';
import type { AuthService } from './AuthService';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function view(overrides: Partial<AccountView> & { id: string }): AccountView {
  return {
    providerId: 'claude-code',
    label: overrides.id,
    email: `${overrides.id}@example.com`,
    isActive: false,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: {
      providerId: 'claude-code',
      accountId: overrides.id,
      state: 'fresh',
      checkedAt: NOW,
      isLive: false,
      refreshExpiresAt: NOW + 6 * DAY,
    },
    ...overrides,
  };
}

function build(views: AccountView[], inference: string): Record<string, unknown> {
  const service = {
    listAccountsWithHealth: vi.fn(() => views),
    onAccountChange: new MockEventEmitter<string>().event,
    onAccountsUpdated: new MockEventEmitter<void>().event,
  } as unknown as AccountService;
  const auth = { getProviderId: () => inference } as unknown as AuthService;
  statusBarItems.length = 0;
  new AccountStatusBar(service, auth);
  return statusBarItems[0];
}

describe('AccountStatusBar', () => {
  it('shows with a single account and hides only when nothing is saved', () => {
    const item = build([view({ id: 'work', isActive: true })], 'claude-api');
    expect(item.visible).toBe(true);
    expect(item.text).toBe('$(account) work');
    expect(item.command).toBe('sidekick.accounts.pick');

    expect(build([], 'claude-max').visible).toBe(false);
  });

  it('prefers the inference provider, then Claude, then Codex, and warns on expiry', () => {
    const views = [
      view({ id: 'claude-acct', isActive: true }),
      view({
        id: 'codex-acct',
        providerId: 'codex',
        isActive: true,
        health: {
          providerId: 'codex',
          accountId: 'codex-acct',
          state: 'expired',
          checkedAt: NOW,
          isLive: false,
        },
      }),
    ];
    const codexFirst = build(views, 'codex');
    expect(codexFirst.text).toBe('$(warning) codex-acct');
    expect((codexFirst.backgroundColor as { id: string }).id).toBe(
      'statusBarItem.warningBackground',
    );

    const claudeFirst = build(views, 'opencode');
    expect(claudeFirst.text).toBe('$(account) claude-acct');
    expect(claudeFirst.backgroundColor).toBeUndefined();
    const tooltip = claudeFirst.tooltip as { value: string; isTrusted?: boolean };
    expect(tooltip.value).toContain(
      '| Claude Code | claude-acct (claude-acct@example.com) | fresh · expires in 6d |',
    );
    expect(tooltip.value).toContain('| Codex |');
    expect(tooltip.isTrusted).not.toBe(true);
  });

  it('abbreviates long emails and flags expiring accounts with a clock', () => {
    const item = build(
      [
        view({
          id: 'averyveryverylonglocalpart',
          label: undefined,
          email: 'averyveryverylonglocalpart@example.com',
          isActive: true,
          health: {
            providerId: 'claude-code',
            accountId: 'x',
            state: 'expiring',
            checkedAt: NOW,
            isLive: false,
            refreshExpiresAt: NOW + DAY,
          },
        }),
      ],
      'claude-max',
    );
    expect(item.text).toBe('$(clock) averyveryver…@example.com');
  });
});
