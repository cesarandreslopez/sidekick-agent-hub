import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
  TreeItem: class {
    id?: string;
    constructor(public label: string) {}
  },
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  MarkdownString: class {
    appendMarkdown() {
      return this;
    }
    appendText() {
      return this;
    }
  },
}));

import { EventStreamTreeProvider } from './EventStreamTreeProvider';

describe('EventStreamTreeProvider', () => {
  it('gives every row a stable, unique id, even once the ring buffer is full', () => {
    let emit: ((event: unknown) => void) | undefined;
    const noop = () => ({ dispose: () => undefined });
    const provider = new EventStreamTreeProvider({
      onTimelineEvent: (handler: (event: unknown) => void) => {
        emit = handler;
        return { dispose: () => undefined };
      },
      onSessionStart: noop,
      onSessionReset: noop,
      onSessionEnd: noop,
    } as never);

    const event = (n: number) => ({
      type: 'tool_call',
      timestamp: new Date(2026, 10, 17, 9, 0, n).toISOString(),
      description: `Read file ${n}`,
    });
    emit!(event(0));
    const firstId = provider.getTreeItem(provider.getChildren()[0]).id;
    for (let n = 1; n <= 250; n++) emit!(event(n));

    const rows = provider.getChildren();
    const ids = rows.map((row) => provider.getTreeItem(row).id);
    expect(new Set(ids).size).toBe(rows.length);
    // The same event keeps its id as newer rows push it down the list.
    const last = rows[rows.length - 1];
    expect(provider.getTreeItem(last).id).toBe(provider.getTreeItem(last).id);
    expect(ids).not.toContain(firstId);
    provider.dispose();
  });
});
