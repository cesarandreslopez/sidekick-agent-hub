import { describe, it, expect, vi } from 'vitest';
import { formatRelativeTime, collectSessionItems } from './SessionPickerHelpers';
import type { SessionProvider } from 'sidekick-shared';

// ── formatRelativeTime ──

describe('formatRelativeTime', () => {
  const now = new Date('2026-02-20T12:00:00Z');

  it('returns "just now" for mtime less than 60s ago', () => {
    const mtime = new Date('2026-02-20T11:59:30Z');
    expect(formatRelativeTime(mtime, now)).toBe('just now');
  });

  it('returns "just now" for future mtime', () => {
    const mtime = new Date('2026-02-20T12:01:00Z');
    expect(formatRelativeTime(mtime, now)).toBe('just now');
  });

  it('returns minutes for 1-59 minutes', () => {
    const mtime5 = new Date('2026-02-20T11:55:00Z');
    expect(formatRelativeTime(mtime5, now)).toBe('5m ago');

    const mtime59 = new Date('2026-02-20T11:01:00Z');
    expect(formatRelativeTime(mtime59, now)).toBe('59m ago');
  });

  it('returns hours for 1-23 hours', () => {
    const mtime2h = new Date('2026-02-20T10:00:00Z');
    expect(formatRelativeTime(mtime2h, now)).toBe('2h ago');

    const mtime23h = new Date('2026-02-19T13:00:00Z');
    expect(formatRelativeTime(mtime23h, now)).toBe('23h ago');
  });

  it('returns days for 24+ hours', () => {
    const mtime3d = new Date('2026-02-17T12:00:00Z');
    expect(formatRelativeTime(mtime3d, now)).toBe('3d ago');

    const mtime1d = new Date('2026-02-19T11:00:00Z');
    expect(formatRelativeTime(mtime1d, now)).toBe('1d ago');
  });
});

// ── collectSessionItems ──

describe('collectSessionItems', () => {
  const now = new Date('2026-02-20T12:00:00Z');

  // Mock fs.statSync — we need to mock the module
  vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
      ...actual,
      statSync: vi.fn(),
    };
  });

  function makeMockProvider(labels: Record<string, string | null>): SessionProvider {
    return {
      id: 'claude-code',
      displayName: 'Claude Code',
      extractSessionLabel: vi.fn((p: string) => labels[p] ?? null),
      findSessionFiles: vi.fn(() => []),
      findAllSessions: vi.fn(() => []),
      getProjectsBaseDir: vi.fn(() => ''),
      readSessionStats: vi.fn(() => ({} as never)),
      searchInSession: vi.fn(() => []),
      getAllProjectFolders: vi.fn(() => []),
      dispose: vi.fn(),
    } as unknown as SessionProvider;
  }

  it('collects items with labels and ages', async () => {
    const { statSync } = await import('fs');
    const mocked = vi.mocked(statSync);
    mocked.mockImplementation((() => ({
      mtime: new Date('2026-02-20T11:55:00Z'),
    })) as never);

    const provider = makeMockProvider({
      '/sessions/abc123.jsonl': 'Fix the login bug',
    });

    const items = collectSessionItems(
      ['/sessions/abc123.jsonl'],
      provider,
      now,
    );

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Fix the login bug');
    expect(items[0].sessionId).toBe('abc123');  // basename without ext (< 8 chars, no truncation)
    expect(items[0].age).toBe('5m ago');
    expect(items[0].isActive).toBe(false);
  });

  it('uses "Untitled session" when label is null', async () => {
    const { statSync } = await import('fs');
    const mocked = vi.mocked(statSync);
    mocked.mockImplementation((() => ({
      mtime: new Date('2026-02-20T11:50:00Z'),
    })) as never);

    const provider = makeMockProvider({});
    const items = collectSessionItems(
      ['/sessions/xyz.jsonl'],
      provider,
      now,
    );

    expect(items[0].label).toBe('Untitled session');
  });

  it('marks sessions active when mtime < 60s ago', async () => {
    const { statSync } = await import('fs');
    const mocked = vi.mocked(statSync);
    mocked.mockImplementation((() => ({
      mtime: new Date('2026-02-20T11:59:30Z'),
    })) as never);

    const provider = makeMockProvider({
      '/sessions/live.jsonl': 'Active session',
    });

    const items = collectSessionItems(
      ['/sessions/live.jsonl'],
      provider,
      now,
    );

    expect(items[0].isActive).toBe(true);
    expect(items[0].age).toBe('just now');
  });

  it('caps at 50 items', async () => {
    const { statSync } = await import('fs');
    const mocked = vi.mocked(statSync);
    mocked.mockImplementation((() => ({
      mtime: new Date('2026-02-20T11:00:00Z'),
    })) as never);

    const paths = Array.from({ length: 60 }, (_, i) =>
      `/sessions/session-${String(i).padStart(3, '0')}.jsonl`
    );
    const provider = makeMockProvider({});

    const items = collectSessionItems(paths, provider, now);
    expect(items).toHaveLength(50);
  });

  it('skips sessions where statSync throws', async () => {
    const { statSync } = await import('fs');
    const mocked = vi.mocked(statSync);
    let call = 0;
    mocked.mockImplementation((() => {
      call++;
      if (call === 1) throw new Error('ENOENT');
      return { mtime: new Date('2026-02-20T11:00:00Z') };
    }) as never);

    const provider = makeMockProvider({
      '/sessions/b.jsonl': 'Second',
    });

    const items = collectSessionItems(
      ['/sessions/a.jsonl', '/sessions/b.jsonl'],
      provider,
      now,
    );

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Second');
  });
});
