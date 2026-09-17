/**
 * Shell-specific rendering of the isolated-account environment, so
 * `eval "$(sidekick accounts env work)"` (or the PowerShell/cmd equivalent)
 * points claude/codex at a saved profile for the current shell only.
 */

import * as path from 'path';

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd';

export const SHELL_KINDS: ShellKind[] = ['bash', 'zsh', 'fish', 'powershell', 'cmd'];

export function parseShellKind(value: string | undefined): ShellKind | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pwsh' || normalized === 'powershell') return 'powershell';
  if (normalized === 'sh') return 'bash';
  return (SHELL_KINDS as string[]).includes(normalized) ? (normalized as ShellKind) : null;
}

export function detectShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellKind {
  if (platform === 'win32') return env.PSModulePath ? 'powershell' : 'cmd';
  const name = path.basename(env.SHELL ?? '');
  if (name === 'fish') return 'fish';
  if (name === 'zsh') return 'zsh';
  return 'bash';
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatEnvExport(
  env: Record<string, string>,
  unset: string[],
  shell: ShellKind,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    switch (shell) {
      case 'fish':
        lines.push(`set -gx ${key} ${posixQuote(value)}`);
        break;
      case 'powershell':
        lines.push(`$env:${key} = ${powershellQuote(value)}`);
        break;
      case 'cmd':
        lines.push(`set "${key}=${value}"`);
        break;
      default:
        lines.push(`export ${key}=${posixQuote(value)}`);
    }
  }
  for (const key of unset) {
    switch (shell) {
      case 'fish':
        lines.push(`set -e ${key}`);
        break;
      case 'powershell':
        lines.push(`Remove-Item Env:${key} -ErrorAction SilentlyContinue`);
        break;
      case 'cmd':
        lines.push(`set "${key}="`);
        break;
      default:
        lines.push(`unset ${key}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** How to apply the output in each shell (printed on stderr for humans). */
export function envUsageHint(shell: ShellKind, name: string): string {
  const cmd = `sidekick accounts env ${name}`;
  switch (shell) {
    case 'fish':
      return `# ${cmd} --shell fish | source`;
    case 'powershell':
      return `# ${cmd} --shell powershell | Invoke-Expression`;
    case 'cmd':
      return `# for /f "delims=" %i in ('${cmd} --shell cmd') do @%i`;
    default:
      return `# eval "$(${cmd})"`;
  }
}

/** The interactive shell to spawn for `sidekick accounts shell`. */
export function defaultShellCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    if (env.PSModulePath) return { command: 'powershell', args: ['-NoLogo'] };
    return { command: env.ComSpec || 'cmd.exe', args: [] };
  }
  return { command: env.SHELL || '/bin/sh', args: [] };
}
