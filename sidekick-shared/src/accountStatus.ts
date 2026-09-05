import { resolveActiveClaudeAccount } from './accounts';
import { resolveActiveCodexAccount } from './codexProfiles';

export interface ActiveProviderAccountStatus {
  present: boolean;
  accountId?: string;
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

export interface ActiveAccountStatusOptions {
  /**
   * Re-point a stale saved-account pointer at the live identity when they
   * disagree (default true). Hot paths such as the status line pass `false`
   * so they never write; an ordinary command repairs the pointer later.
   */
  selfHeal?: boolean;
}

/**
 * Reads active Claude Code and Codex account status in one filesystem pass.
 *
 * If reading either provider throws, the result still has provider-shaped
 * fields so startup flows can render a consistent "not configured" state.
 */
export function getActiveAccountStatus(
  error?: string,
  options: ActiveAccountStatusOptions = {},
): ActiveAccountStatus {
  try {
    const claudeAccount = resolveActiveClaudeAccount(options);
    const codexAccount = resolveActiveCodexAccount(options);

    const claude =
      claudeAccount.source !== 'none'
        ? {
            present: true,
            ...(claudeAccount.registryAccountId
              ? { accountId: claudeAccount.registryAccountId }
              : {}),
            email: claudeAccount.email,
            label: claudeAccount.label ?? claudeAccount.email,
          }
        : { present: false };
    const codex =
      codexAccount.source !== 'none'
        ? {
            present: true,
            ...(codexAccount.registryAccountId
              ? { accountId: codexAccount.registryAccountId }
              : {}),
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
