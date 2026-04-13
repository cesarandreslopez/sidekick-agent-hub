import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

const mockResolveSidekickCodexHome = vi.hoisted(() => vi.fn(() => '/managed/.codex'));
const mockGetCodexMonitoringHomes = vi.hoisted(() => vi.fn(() => ['/managed/.codex', '/system/.codex']));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('../codexProfiles', () => ({
  resolveSidekickCodexHome: mockResolveSidekickCodexHome,
  getCodexMonitoringHomes: mockGetCodexMonitoringHomes,
}));

import { detectProvider } from './detect';

describe('detectProvider', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 0, mtime: new Date(0) } as fs.Stats);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    mockResolveSidekickCodexHome.mockReturnValue('/managed/.codex');
    mockGetCodexMonitoringHomes.mockReturnValue(['/managed/.codex', '/system/.codex']);
  });

  it('returns override when specified', () => {
    expect(detectProvider('opencode')).toBe('opencode');
    expect(detectProvider('codex')).toBe('codex');
    expect(detectProvider('claude-code')).toBe('claude-code');
  });

  it('defaults to claude-code when no providers detected', () => {
    expect(detectProvider()).toBe('claude-code');
  });

  it('detects claude-code when ~/.claude/projects exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p).includes('.claude/projects');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readdirSync).mockReturnValue(['session1'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, mtime: new Date(1000) } as fs.Stats);
    expect(detectProvider()).toBe('claude-code');
  });

  it('detects codex when the system ~/.codex has activity but the managed profile home does not', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === '/system/.codex/sessions';
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
      if (String(p) === '/system/.codex/sessions') return ['2026'] as any;
      return [] as any;
    });
    vi.mocked(fs.statSync).mockImplementation((p: fs.PathLike) => {
      if (String(p) === '/system/.codex/sessions/2026') {
        return { mtimeMs: 2000, mtime: new Date(2000) } as fs.Stats;
      }
      return { mtimeMs: 0, mtime: new Date(0) } as fs.Stats;
    });

    expect(detectProvider()).toBe('codex');
  });
});
