import { resolveActiveClaudeAccount } from './accounts';
import { resolveActiveCodexAccount } from './codexProfiles';

export interface ActiveProviderAccountStatus {
  present: boolean;
  email?: string;
  label?: string;
}

export interface ActiveAccountStatus {
  ok: boolean;
  claude: ActiveProviderAccountStatus;
  codex: ActiveProviderAccountStatus;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads active Claude Code and Codex account status in one filesystem pass.
 *
 * If reading either provider throws, the result still has provider-shaped
 * fields so startup flows can render a consistent "not configured" state.
 */
export function getActiveAccountStatus(error?: string): ActiveAccountStatus {
  try {
    const claudeAccount = resolveActiveClaudeAccount();
    const codexAccount = resolveActiveCodexAccount();

    const claude =
      claudeAccount.source !== 'none'
        ? {
            present: true,
            email: claudeAccount.email,
            label: claudeAccount.label ?? claudeAccount.email,
          }
        : { present: false };
    const codex =
      codexAccount.source !== 'none'
        ? {
            present: true,
            email: codexAccount.email,
            label: codexAccount.label ?? codexAccount.email ?? codexAccount.providerAccountId,
          }
        : { present: false };

    return {
      ok: claude.present || codex.present,
      claude,
      codex,
      error,
    };
  } catch (caught) {
    return {
      ok: false,
      claude: { present: false },
      codex: { present: false },
      error: error ?? errorMessage(caught),
    };
  }
}
