/**
 * Pure parsers for the provider CLIs' read-only sign-in status commands,
 * `claude auth status --json` and `codex login status`. They do no I/O. The
 * caller runs the command with its own environment, home, and timeout, and
 * passes the output here.
 *
 * A status command reports which credential the CLI would use. It does not
 * prove that a request will authenticate: an expired or revoked token can
 * still read as logged in.
 *
 * @module authStatus
 */

/** Larger outputs are not a status report; reading stops there. */
const MAX_STATUS_OUTPUT = 256 * 1024;
const MAX_DETAIL = 200;

/** `claude auth status --json`, projected. */
export interface ParsedClaudeAuthStatus {
  /** True only when the output is a JSON object with `"loggedIn": true`. */
  loggedIn: boolean;
  /** `authMethod` as reported, e.g. `claude.ai`, `oauth_token`, or `api_key`. */
  method?: string;
  email?: string;
  subscriptionType?: string;
  /**
   * The parsed JSON object. When it is absent the output was not a JSON
   * object, so `loggedIn: false` means "unrecognized", not "signed out".
   */
  raw?: unknown;
}

/** `codex login status`, projected. */
export interface ParsedCodexLoginStatus {
  /** True only when the output starts with `Logged in`. */
  loggedIn: boolean;
  /**
   * `api-key` for any API-key login, `chatgpt` for a ChatGPT sign-in. Absent
   * for other logins (access tokens) and when not logged in.
   */
  method?: 'chatgpt' | 'api-key';
  /**
   * The first line of output, bounded, without the masked key Codex appends to
   * an API-key login. For display and logs, not for decisions.
   */
  detail?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  const candidates = [trimmed];
  // Tolerate warning lines printed ahead of the JSON document, which must
  // then start a line and run to the end of the output.
  const start = trimmed.search(/\n[ \t]*\{/);
  if (start >= 0) candidates.push(trimmed.slice(start).trim());
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

/**
 * Parse the stdout of `claude auth status --json`. Claude Code exits 1 while
 * printing valid signed-out JSON, so parse stdout whatever the exit status
 * was. Only a JSON `"loggedIn": true` counts as logged in.
 */
export function parseClaudeAuthStatus(stdout: string): ParsedClaudeAuthStatus {
  const raw =
    typeof stdout === 'string' && stdout.length <= MAX_STATUS_OUTPUT
      ? parseJsonObject(stdout)
      : undefined;
  if (!raw) return { loggedIn: false };
  const method = stringField(raw, 'authMethod');
  const email = stringField(raw, 'email');
  const subscriptionType = stringField(raw, 'subscriptionType');
  return {
    loggedIn: raw.loggedIn === true,
    ...(method ? { method } : {}),
    ...(email ? { email } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    raw,
  };
}

/**
 * Parse the output of `codex login status`. Codex prints its status line to
 * stderr (`Logged in using ChatGPT`, `Logged in using an API key - sk-…`,
 * `Not logged in`), so pass both streams. The exit status is not consulted:
 * callers that require exit 0 check it themselves.
 */
export function parseCodexLoginStatus(stdout: string, stderr?: string): ParsedCodexLoginStatus {
  const combined = `${typeof stdout === 'string' ? stdout : ''}\n${
    typeof stderr === 'string' ? stderr : ''
  }`.trim();
  const firstLine = combined.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const detail = (/^(Logged in using .*?API key)\s+-\s.*$/i.exec(firstLine)?.[1] ?? firstLine)
    .slice(0, MAX_DETAIL)
    .trim();
  const withDetail = detail ? { detail } : {};
  if (!/^Logged in/i.test(combined)) return { loggedIn: false, ...withDetail };
  if (/API key/i.test(combined)) return { loggedIn: true, method: 'api-key', ...withDetail };
  if (/ChatGPT/i.test(combined)) return { loggedIn: true, method: 'chatgpt', ...withDetail };
  return { loggedIn: true, ...withDetail };
}
