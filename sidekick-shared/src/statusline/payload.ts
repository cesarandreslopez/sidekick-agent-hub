/**
 * `sidekick-shared/statusline/payload` — the pure Claude Code status-line
 * stdin parser on its own, for hosts with a tight bundle budget that render
 * their own line. Loads no account, credential, quota-snapshot, or network
 * code (the full `sidekick-shared/statusline` entry does).
 *
 * @module statusline/payload
 */

export {
  parseClaudeStatuslinePayload,
  quotaFromStatuslinePayload,
} from './claudeStatuslinePayload';
export type {
  ClaudeStatuslinePayload,
  ClaudeStatuslineRateLimitWindow,
  QuotaFromStatuslineOptions,
} from './claudeStatuslinePayload';
