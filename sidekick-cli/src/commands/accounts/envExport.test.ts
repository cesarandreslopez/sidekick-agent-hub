import { describe, expect, it } from 'vitest';
import {
  defaultShellCommand,
  detectShell,
  envUsageHint,
  formatEnvExport,
  parseShellKind,
} from './envExport';

const ENV = { CLAUDE_CONFIG_DIR: "/Users/me/.config/sidekick/accounts/claude/profiles/it's/home" };
const UNSET = ['CLAUDE_SECURESTORAGE_CONFIG_DIR'];

describe('envExport', () => {
  it('renders each shell dialect with safe quoting', () => {
    expect(formatEnvExport(ENV, UNSET, 'bash')).toBe(
      "export CLAUDE_CONFIG_DIR='/Users/me/.config/sidekick/accounts/claude/profiles/it'\\''s/home'\nunset CLAUDE_SECURESTORAGE_CONFIG_DIR\n",
    );
    expect(formatEnvExport(ENV, UNSET, 'zsh')).toBe(formatEnvExport(ENV, UNSET, 'bash'));
    expect(formatEnvExport(ENV, UNSET, 'fish')).toBe(
      "set -gx CLAUDE_CONFIG_DIR '/Users/me/.config/sidekick/accounts/claude/profiles/it'\\''s/home'\nset -e CLAUDE_SECURESTORAGE_CONFIG_DIR\n",
    );
    expect(formatEnvExport(ENV, UNSET, 'powershell')).toBe(
      "$env:CLAUDE_CONFIG_DIR = '/Users/me/.config/sidekick/accounts/claude/profiles/it''s/home'\nRemove-Item Env:CLAUDE_SECURESTORAGE_CONFIG_DIR -ErrorAction SilentlyContinue\n",
    );
    expect(formatEnvExport({ CODEX_HOME: 'C:\\Users\\me\\codex-home' }, [], 'cmd')).toBe(
      'set "CODEX_HOME=C:\\Users\\me\\codex-home"\n',
    );
  });

  it('detects the shell from the platform and environment', () => {
    expect(detectShell({ SHELL: '/usr/local/bin/fish' }, 'darwin')).toBe('fish');
    expect(detectShell({ SHELL: '/bin/zsh' }, 'linux')).toBe('zsh');
    expect(detectShell({}, 'linux')).toBe('bash');
    expect(detectShell({ PSModulePath: 'C:\\x' }, 'win32')).toBe('powershell');
    expect(detectShell({}, 'win32')).toBe('cmd');
    expect(parseShellKind('pwsh')).toBe('powershell');
    expect(parseShellKind('sh')).toBe('bash');
    expect(parseShellKind('nushell')).toBeNull();
  });

  it('prints the usage hint and picks the subshell per platform', () => {
    expect(envUsageHint('bash', '"work"')).toBe('# eval "$(sidekick accounts env "work")"');
    expect(envUsageHint('fish', 'work')).toBe('# sidekick accounts env work --shell fish | source');
    expect(envUsageHint('powershell', 'work')).toBe(
      '# sidekick accounts env work --shell powershell | Invoke-Expression',
    );
    expect(envUsageHint('cmd', 'work')).toBe(
      `# for /f "delims=" %i in ('sidekick accounts env work --shell cmd') do @%i`,
    );
    expect(defaultShellCommand({ SHELL: '/bin/zsh' }, 'darwin')).toEqual({
      command: '/bin/zsh',
      args: [],
    });
    expect(defaultShellCommand({}, 'linux')).toEqual({ command: '/bin/sh', args: [] });
    expect(defaultShellCommand({ PSModulePath: 'x' }, 'win32')).toEqual({
      command: 'powershell',
      args: ['-NoLogo'],
    });
    expect(defaultShellCommand({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: [],
    });
  });
});
