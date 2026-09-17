import { describe, expect, it } from 'vitest';
import {
  identitiesMatch,
  parseAuthJson,
  parseJwtPayload,
  readAccessTokenExpiry,
  readAuthIdentityFromRaw,
  readLastRefresh,
} from './codexAuth';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('codexAuth', () => {
  it('decodes identity claims from the id token', () => {
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: makeJwt({
          'https://api.openai.com/profile': { email: 'me@example.com' },
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'ws-1',
            chatgpt_plan_type: 'pro',
          },
        }),
        access_token: 'x',
        refresh_token: 'y',
        account_id: 'fallback',
      },
      last_refresh: '2026-09-12T02:48:09.294839Z',
    });

    expect(readAuthIdentityFromRaw(raw)).toEqual({
      email: 'me@example.com',
      workspaceId: 'ws-1',
      planType: 'pro',
      authMode: 'chatgpt',
    });
    expect(readLastRefresh(raw)).toBe(Date.parse('2026-09-12T02:48:09.294839Z'));
  });

  it('treats API-key files as api-key auth and tolerates garbage', () => {
    expect(readAuthIdentityFromRaw(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toEqual({
      email: undefined,
      workspaceId: undefined,
      planType: undefined,
      authMode: 'api-key',
    });
    expect(readAuthIdentityFromRaw('not json')).toBeNull();
    expect(readAuthIdentityFromRaw(null)).toBeNull();
    expect(parseAuthJson('"a string"')).toBeNull();
    expect(parseJwtPayload('nodots')).toBeNull();
  });

  it('reads the access-token expiry from its exp claim in milliseconds', () => {
    const raw = JSON.stringify({
      tokens: { access_token: makeJwt({ exp: 1_800_000_000 }) },
    });
    expect(readAccessTokenExpiry(raw)).toBe(1_800_000_000_000);
    expect(
      readAccessTokenExpiry(JSON.stringify({ tokens: { access_token: 'opaque' } })),
    ).toBeNull();
    expect(readAccessTokenExpiry(null)).toBeNull();
  });

  it('matches identities by workspace first, then email', () => {
    expect(
      identitiesMatch({ workspaceId: 'a', email: 'x' }, { workspaceId: 'a', email: 'y' }),
    ).toBe(true);
    expect(
      identitiesMatch({ workspaceId: 'a', email: 'x' }, { workspaceId: 'b', email: 'x' }),
    ).toBe(false);
    expect(identitiesMatch({ email: 'x' }, { workspaceId: 'b', email: 'x' })).toBe(true);
    expect(identitiesMatch({ email: 'x' }, { email: 'y' })).toBe(false);
    expect(identitiesMatch(null, { email: 'y' })).toBe(false);
    expect(identitiesMatch({}, {})).toBe(false);
  });
});
