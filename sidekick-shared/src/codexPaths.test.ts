import { afterEach, describe, expect, it } from 'vitest';
import { forceFileCredentialStore, getCodexExecutionEnv, getSystemCodexHome } from './codexPaths';

describe('getCodexExecutionEnv', () => {
  afterEach(() => {
    delete process.env.CODEX_HOME;
  });

  it('sets CODEX_HOME to the live home when the base env has none', () => {
    const env = getCodexExecutionEnv({ PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: getSystemCodexHome() });
  });

  it("keeps a caller's own CODEX_HOME", () => {
    process.env.CODEX_HOME = '/tmp/live-codex';
    expect(getCodexExecutionEnv({ CODEX_HOME: '/tmp/isolated-codex' }).CODEX_HOME).toBe(
      '/tmp/isolated-codex',
    );
  });

  it('treats a blank CODEX_HOME in the base env as unset', () => {
    process.env.CODEX_HOME = '/tmp/live-codex';
    expect(getCodexExecutionEnv({ CODEX_HOME: '  ' }).CODEX_HOME).toBe('/tmp/live-codex');
  });

  it('defaults to process.env', () => {
    process.env.CODEX_HOME = '/tmp/live-codex';
    expect(getCodexExecutionEnv().CODEX_HOME).toBe('/tmp/live-codex');
  });
});

describe('forceFileCredentialStore', () => {
  it('adds the key to an empty config', () => {
    expect(forceFileCredentialStore('')).toBe('cli_auth_credentials_store = "file"\n');
  });

  it('appends the key when the config has no tables', () => {
    expect(forceFileCredentialStore('model = "gpt-5"\n')).toBe(
      'model = "gpt-5"\ncli_auth_credentials_store = "file"\n',
    );
  });

  it('keeps the key at the top level when the config ends with tables', () => {
    const config =
      'model = "gpt-5"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[mcp_servers.x]\ncommand = "x"\n';
    const out = forceFileCredentialStore(config);
    const firstTable = out.indexOf('[');
    expect(out.indexOf('cli_auth_credentials_store = "file"')).toBeLessThan(firstTable);
    expect(out).toContain(
      'model = "gpt-5"\ncli_auth_credentials_store = "file"\n\n[projects."/a"]',
    );
    expect(out).toContain('[mcp_servers.x]\ncommand = "x"\n');
  });

  it('inserts before a leading table when there is no top-level content', () => {
    expect(forceFileCredentialStore('[projects."/a"]\ntrust_level = "trusted"\n')).toBe(
      'cli_auth_credentials_store = "file"\n\n[projects."/a"]\ntrust_level = "trusted"\n',
    );
  });

  it('rewrites an existing value in place', () => {
    expect(forceFileCredentialStore('cli_auth_credentials_store = "keyring"\n[a]\nb = 1\n')).toBe(
      'cli_auth_credentials_store = "file"\n[a]\nb = 1\n',
    );
  });
  it('forces a single-quoted store setting and ignores similarly named nested settings', () => {
    expect(forceFileCredentialStore("cli_auth_credentials_store = 'auto'\n")).toBe(
      'cli_auth_credentials_store = "file"\n',
    );
    const nested = '[other]\ncli_auth_credentials_store = "keyring"\n';
    expect(forceFileCredentialStore(nested)).toBe(
      'cli_auth_credentials_store = "file"\n\n' + nested,
    );
  });
});
