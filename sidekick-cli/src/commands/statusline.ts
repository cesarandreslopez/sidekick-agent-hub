import {
  formatStatusline,
  getActiveAccountStatus,
  readQuotaSnapshot,
} from 'sidekick-shared/statusline';

/** Cache-only hot path used on every agent prompt. */
export function statuslineAction(): void {
  const accounts = getActiveAccountStatus();
  const claudeQuota = accounts.claude.accountId
    ? readQuotaSnapshot('claude-code', accounts.claude.accountId)
    : null;
  const codexQuota = accounts.codex.accountId
    ? readQuotaSnapshot('codex', accounts.codex.accountId)
    : null;
  process.stdout.write(`${formatStatusline({ accounts, claudeQuota, codexQuota })}\n`);
}
