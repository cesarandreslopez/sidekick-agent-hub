import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from 'sidekick-shared';

const { MockTreeItem, MockThemeIcon, MockThemeColor, MockMarkdownString, MockEventEmitter } =
  vi.hoisted(() => ({
    MockTreeItem: class {
      label: string;
      collapsibleState: number;
      description?: string;
      iconPath?: unknown;
      tooltip?: unknown;
      id?: string;
      contextValue?: string;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    MockThemeIcon: class {
      constructor(
        public id: string,
        public color?: unknown,
      ) {}
    },
    MockThemeColor: class {
      constructor(public id: string) {}
    },
    MockMarkdownString: class {
      isTrusted: boolean | undefined;
      constructor(public value = '') {}
    },
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
  }));

vi.mock('vscode', () => ({
  TreeItem: MockTreeItem,
  ThemeIcon: MockThemeIcon,
  ThemeColor: MockThemeColor,
  MarkdownString: MockMarkdownString,
  EventEmitter: MockEventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { AccountTreeProvider, type AccountTreeElement } from './AccountTreeProvider';
import type { AccountService } from '../services/AccountService';

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

function makeService(views: AccountView[]): AccountService {
  const change = new MockEventEmitter<string>();
  const updated = new MockEventEmitter<void>();
  return {
    listAccountsWithHealth: vi.fn(() => views),
    onAccountChange: change.event,
    onAccountsUpdated: updated.event,
  } as unknown as AccountService;
}

describe('AccountTreeProvider', () => {
  const views = [
    view({ id: 'work', isActive: true, planType: 'max' }),
    view({
      id: 'old',
      health: {
        providerId: 'claude-code',
        accountId: 'old',
        state: 'expired',
        checkedAt: NOW,
        isLive: false,
      },
    }),
    view({
      id: 'c',
      providerId: 'codex',
      label: 'Client',
      source: 'learned',
      health: {
        providerId: 'codex',
        accountId: 'c',
        state: 'expiring',
        checkedAt: NOW,
        isLive: true,
        refreshExpiresAt: NOW + DAY,
      },
    }),
  ];

  it('groups accounts by provider in a fixed order with counts', () => {
    const provider = new AccountTreeProvider(makeService(views));
    const groups = provider.getChildren() as Array<Extract<AccountTreeElement, { kind: 'group' }>>;
    expect(groups.map((g) => [g.providerId, g.accounts.length])).toEqual([
      ['claude-code', 2],
      ['codex', 1],
    ]);
    const item = provider.getTreeItem(groups[0]) as unknown as {
      label: string;
      description: string;
      contextValue: string;
    };
    expect(item.label).toBe('Claude Code');
    expect(item.description).toBe('2 accounts · work active');
    expect(item.contextValue).toBe('accountGroup');
    expect(provider.getChildren(groups[1])).toEqual([{ kind: 'account', view: views[2] }]);
  });

  it('splits contextValue by state so inline actions gate correctly', () => {
    const provider = new AccountTreeProvider(makeService(views));
    const items = views.map(
      (v) =>
        provider.getTreeItem({ kind: 'account', view: v }) as unknown as {
          contextValue: string;
          description: string;
          iconPath: { id: string };
          tooltip: { value: string; isTrusted?: boolean };
        },
    );
    expect(items.map((i) => i.contextValue)).toEqual([
      'account.active',
      'account.expired',
      'account.inactive',
    ]);
    expect(items[0].description).toBe('(current) · work@example.com · max · fresh · expires in 6d');
    expect(items[0].iconPath.id).toBe('pass-filled');
    expect(items[1].iconPath.id).toBe('error');
    expect(items[2].iconPath.id).toBe('warning');
    expect(items[2].tooltip.value).toContain('Registered automatically from your live login');
    expect(items[2].tooltip.isTrusted).not.toBe(true);
  });

  it('shows a hint and an expired-count badge on the view', () => {
    const provider = new AccountTreeProvider(makeService(views));
    const treeView = {
      message: undefined as string | undefined,
      badge: undefined as { value: number; tooltip: string } | undefined,
    };
    provider.setTreeView(treeView as never);
    expect(treeView.message).toContain('Sign In Again');
    expect(treeView.badge).toEqual({ value: 1, tooltip: '1 expired account' });

    const empty = new AccountTreeProvider(makeService([]));
    const emptyView = { message: 'x', badge: { value: 1, tooltip: '' } };
    empty.setTreeView(emptyView as never);
    expect(emptyView.message).toBeUndefined();
    expect(emptyView.badge).toBeUndefined();
    expect(empty.getChildren()).toEqual([]);
  });
});
