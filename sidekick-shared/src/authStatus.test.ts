import { describe, expect, it } from 'vitest';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from './authStatus';
import { parseCodexLoginStatusOutput } from './codexProfiles';

describe('parseClaudeAuthStatus', () => {
  const signedIn = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'dev@example.com',
    orgId: '00000000-0000-4000-8000-000000000000',
    orgName: 'Example Org',
    subscriptionType: 'max',
  };

  it('projects a signed-in subscription login', () => {
    const stdout = `${JSON.stringify(signedIn, null, 2)}\n`;
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'dev@example.com',
      subscriptionType: 'max',
      raw: signedIn,
    });
  });

  it('projects an API-key login without account fields', () => {
    const raw = {
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      apiKeySource: 'ANTHROPIC_API_KEY',
    };
    expect(parseClaudeAuthStatus(JSON.stringify(raw))).toEqual({
      loggedIn: true,
      method: 'api_key',
      raw,
    });
  });

  it('reports a signed-out JSON document as signed out, keeping raw', () => {
    const raw = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
    expect(parseClaudeAuthStatus(JSON.stringify(raw))).toEqual({
      loggedIn: false,
      method: 'none',
      raw,
    });
  });

  it('tolerates a warning line ahead of the JSON', () => {
    const stdout = `Warning: update available\n${JSON.stringify(signedIn)}\n`;
    expect(parseClaudeAuthStatus(stdout)).toMatchObject({ loggedIn: true, raw: signedIn });
  });

  it.each([
    ['empty output', ''],
    ['plain text', 'Logged in as dev@example.com'],
    ['signed-out text', 'Not logged in. Run claude auth login.'],
    ['malformed JSON', '{"loggedIn": true'],
    ['JSON array', '[{"loggedIn": true}]'],
    ['JSON scalar', 'true'],
    ['truthy non-boolean', '{"loggedIn": "true"}'],
    ['oversized output', `{"loggedIn": true, "pad": "${'x'.repeat(256 * 1024)}"}`],
  ])('never infers a login from %s', (_name, stdout) => {
    const result = parseClaudeAuthStatus(stdout);
    expect(result.loggedIn).toBe(false);
  });

  it('marks unrecognized output by leaving raw absent', () => {
    expect(parseClaudeAuthStatus('Logged in as dev@example.com')).toEqual({ loggedIn: false });
    expect(parseClaudeAuthStatus('{"loggedIn": "true"}').raw).toEqual({ loggedIn: 'true' });
  });

  it('ignores non-string and blank fields', () => {
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({ loggedIn: true, authMethod: 7, email: '  ', subscriptionType: null }),
      ),
    ).toEqual({
      loggedIn: true,
      raw: { loggedIn: true, authMethod: 7, email: '  ', subscriptionType: null },
    });
  });
});

describe('parseCodexLoginStatus', () => {
  it.each([
    [
      'ChatGPT on stderr',
      '',
      'Logged in using ChatGPT\n',
      { loggedIn: true, method: 'chatgpt', detail: 'Logged in using ChatGPT' },
    ],
    [
      'API key with masked suffix',
      '',
      'Logged in using an API key - sk-proj-***ABCDE\n',
      { loggedIn: true, method: 'api-key', detail: 'Logged in using an API key' },
    ],
    [
      'Bedrock API key',
      '',
      'Logged in using Amazon Bedrock API key\n',
      { loggedIn: true, method: 'api-key', detail: 'Logged in using Amazon Bedrock API key' },
    ],
    [
      'access token',
      '',
      'Logged in using access token\n',
      { loggedIn: true, detail: 'Logged in using access token' },
    ],
    [
      'status on stdout',
      'Logged in using ChatGPT\n',
      undefined,
      { loggedIn: true, method: 'chatgpt', detail: 'Logged in using ChatGPT' },
    ],
    ['not logged in', '', 'Not logged in\n', { loggedIn: false, detail: 'Not logged in' }],
    [
      'probe error',
      '',
      'Error checking login status: permission denied\n',
      { loggedIn: false, detail: 'Error checking login status: permission denied' },
    ],
    ['no output', '', '', { loggedIn: false }],
  ] as const)('parses %s', (_name, stdout, stderr, expected) => {
    expect(parseCodexLoginStatus(stdout, stderr)).toEqual(expected);
  });

  it('bounds the detail line', () => {
    const detail = parseCodexLoginStatus(
      '',
      `Error checking login status: ${'x'.repeat(500)}`,
    ).detail!;
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail.startsWith('Error checking login status: ')).toBe(true);
  });

  it('does not read a login from a later line', () => {
    expect(parseCodexLoginStatus('notice: config migrated\n', 'Logged in using ChatGPT')).toEqual({
      loggedIn: false,
      detail: 'notice: config migrated',
    });
  });
});

describe('parseCodexLoginStatusOutput (existing caller)', () => {
  // The inline implementation this module replaced, kept to prove parity.
  function previous(status: number | null, stdout: string) {
    const trimmed = stdout.trim();
    if (status === 0 && /^Logged in/i.test(trimmed)) {
      if (/API key/i.test(trimmed)) return { loggedIn: true, authMode: 'api-key' };
      if (/ChatGPT/i.test(trimmed)) return { loggedIn: true, authMode: 'chatgpt' };
      return { loggedIn: true };
    }
    return { loggedIn: false };
  }

  const outputs = [
    '\nLogged in using ChatGPT\n',
    '\nLogged in using an API key - sk-proj-***ABCDE\n',
    '\nLogged in using Amazon Bedrock API key\n',
    '\nLogged in using personal access token\n',
    'Logged in using ChatGPT\n\n',
    '\nNot logged in\n',
    '\nError checking login status: boom\n',
    'notice\nLogged in using ChatGPT\n',
    'logged in using chatgpt',
    'Logged in using ChatGPT\nWarning: OPENAI_API_KEY is set\n',
    '',
    '\n',
  ];

  it.each(outputs.flatMap((output) => [0, 1, null].map((status) => [status, output] as const)))(
    'matches the previous parser for status %s and %j',
    (status, output) => {
      expect(parseCodexLoginStatusOutput(status, output)).toEqual(previous(status, output));
    },
  );
});
