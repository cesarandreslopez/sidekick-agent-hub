import { describe, expect, it } from 'vitest';
import { forceFileCredentialStore } from './codexPaths';

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
});
