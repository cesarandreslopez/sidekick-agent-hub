import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { detectProvider } from './detect';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe('detectProvider', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 0, mtime: new Date(0) } as fs.Stats);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
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
});
