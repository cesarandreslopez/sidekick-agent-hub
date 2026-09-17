import { describe, expect, it } from 'vitest';
import type { AccountView } from 'sidekick-shared';
import { parseProviderFilter, resolveAccount } from './resolveAccount';

function view(
  id: string,
  providerId: 'claude-code' | 'codex',
  label?: string,
  email?: string,
): AccountView {
  return {
    id,
    providerId,
    label,
    email,
    isActive: false,
    source: 'registered',
    addedAt: '2026-01-01T00:00:00Z',
    health: { providerId, accountId: id, state: 'fresh', checkedAt: 0, isLive: false },
  };
}

const VIEWS = [
  view('uuid-work', 'claude-code', 'Work', 'work@example.com'),
  view('uuid-home', 'claude-code', 'Home', 'home@example.com'),
  view('codex-1', 'codex', 'Work', 'work@example.com'),
  view('codex-2', 'codex', 'Client', 'client@corp.com'),
];

describe('resolveAccount', () => {
  it('matches by id, email, and label case-insensitively', () => {
    expect(resolveAccount(VIEWS, 'uuid-home')).toEqual({ account: VIEWS[1] });
    expect(resolveAccount(VIEWS, 'HOME@example.com')).toEqual({ account: VIEWS[1] });
    expect(resolveAccount(VIEWS, 'client')).toEqual({ account: VIEWS[3] });
  });

  it('resolves unique prefixes and reports ambiguity with candidates', () => {
    expect(resolveAccount(VIEWS, 'cli')).toEqual({ account: VIEWS[3] });
    const ambiguous = resolveAccount(VIEWS, 'work');
    expect('error' in ambiguous && ambiguous.error).toMatch(/matches 2 accounts/);
    expect('candidates' in ambiguous && ambiguous.candidates).toHaveLength(2);
    const prefixAmbiguous = resolveAccount(VIEWS, 'uuid-');
    expect('error' in prefixAmbiguous && prefixAmbiguous.error).toMatch(
      /ambiguous: Work \(work@example\.com\), Home/,
    );
  });

  it('scopes by provider and reports misses', () => {
    expect(resolveAccount(VIEWS, 'work', 'codex')).toEqual({ account: VIEWS[2] });
    const miss = resolveAccount(VIEWS, 'nobody', 'codex');
    expect('error' in miss && miss.error).toBe('No saved Codex account matches "nobody".');
    expect('error' in resolveAccount(VIEWS, '   ')).toBe(true);
  });

  it('parses provider filters', () => {
    expect(parseProviderFilter(undefined)).toEqual({});
    expect(parseProviderFilter('all')).toEqual({});
    expect(parseProviderFilter('auto')).toEqual({});
    expect(parseProviderFilter('claude')).toEqual({ provider: 'claude-code' });
    expect(parseProviderFilter('Codex')).toEqual({ provider: 'codex' });
    expect(parseProviderFilter('opencode').error).toMatch(/not supported/);
    expect(parseProviderFilter('gemini').error).toMatch(/Unknown provider/);
  });
});
