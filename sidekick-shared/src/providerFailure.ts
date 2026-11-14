import type { AccountProviderId } from './providerIds';

export const PROVIDER_CREDENTIAL_KINDS = ['oauth', 'api-key', 'unknown'] as const;
export type ProviderCredentialKind = (typeof PROVIDER_CREDENTIAL_KINDS)[number];

export const PROVIDER_AUTHENTICATION_STATES = [
  'authenticated',
  'missing',
  'signed-out',
  'expired',
  'rejected',
  'unknown',
] as const;
export const PROVIDER_AUTHENTICATION_SOURCES = ['local-check', 'provider-response'] as const;

export interface ProviderAuthenticationEvidence {
  credentialKind: ProviderCredentialKind;
  state: (typeof PROVIDER_AUTHENTICATION_STATES)[number];
  checkedAt: string;
  source: (typeof PROVIDER_AUTHENTICATION_SOURCES)[number];
}

export interface ProviderFailureInput {
  provider: AccountProviderId;
  credentialKind: ProviderCredentialKind;
  /** The caller, not this helper, determines whether the error is terminal. */
  error: unknown;
  /** The caller owns freshness and relevance of this separate observation. */
  authentication?: ProviderAuthenticationEvidence;
}

export const PROVIDER_FAILURE_CODES = [
  'missing_credentials',
  'oauth_reauthentication_required',
  'api_credentials_rejected',
  'authentication_rejected',
  'invalid_provider_session',
  'service_unavailable',
  'connection_failed',
  'timeout',
  'rate_limited',
  'overloaded',
  'execution_policy_denied',
  'runtime_unavailable',
  'context_overflow',
  /**
   * The requested model does not exist or this account cannot use it (Codex
   * `modelNotFound`, OpenAI `model_not_found`, an Anthropic `not_found_error`
   * naming a model). Since 0.33.0.
   */
  'model_unavailable',
  'unknown',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export const PROVIDER_RECOVERY_ACTIONS = [
  'sign_in',
  'update_credentials',
  'check_authentication',
  'start_new_session',
  'retry_later',
  'check_connection',
  'review_execution_policy',
  'repair_runtime',
  'reduce_context',
  /** Pick a model the account can use (for `model_unavailable`). Since 0.33.0. */
  'choose_model',
  'inspect_error',
] as const;
export type ProviderRecoveryAction = (typeof PROVIDER_RECOVERY_ACTIONS)[number];

export type ProviderRetryAfter = { kind: 'delay'; delayMs: number } | { kind: 'date'; at: string };

/**
 * Size and range limits enforced by `boundedProviderFailureDiagnosisSchema`
 * (`sidekick-shared/schemas`). Every value `diagnoseProviderFailure()`
 * returns is well inside them. Plain data, also on the Zod-free
 * `sidekick-shared/providerFailure` entry (since 0.33.0), so a consumer that
 * keeps its own validator can tie it to these numbers.
 */
export const PROVIDER_FAILURE_DIAGNOSIS_BOUNDS = {
  /** `checkedAt` and `retryAfter.at` length; an ISO timestamp is 24 characters. */
  timestampMinChars: 1,
  timestampMaxChars: 32,
  /** `httpStatus`, an integer. */
  httpStatusMin: 100,
  httpStatusMax: 599,
  /** `retryAfter.delayMs`, finite. */
  delayMsMin: 0,
  delayMsMax: Number.MAX_SAFE_INTEGER,
  /** Entries in `evidence`; the classifier returns at most one. */
  maxEvidence: 8,
} as const;

export const PROVIDER_FAILURE_EVIDENCE_SOURCES = [
  'structured-error',
  'http-status',
  'message',
  'authentication-check',
] as const;

/**
 * The variants Codex reports in `codexErrorInfo` on `error` and failed-turn
 * payloads (app-server camelCase spelling; the snake_case spelling Codex
 * writes to rollout files is accepted too), in upstream order as of Codex
 * `rust-v0.167.0`. `bioPolicy` and `invalidPrompt` exist only in the core
 * protocol (rollouts, `exec --json`); the app-server reports them as `other`.
 * A variant newer than this list decodes as `other` with its `rawKind`.
 */
export const CODEX_ERROR_INFO_KINDS = [
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'modelNotFound',
  'policyCapacityUnavailable',
  'cyberPolicy',
  'bioPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'invalidPrompt',
  'threadRollbackFailed',
  'sandboxError',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
  'other',
] as const;
export type CodexErrorInfoKind = (typeof CODEX_ERROR_INFO_KINDS)[number];

/** A decoded `codexErrorInfo`: its closed variant and any upstream HTTP status. */
export interface CodexErrorInfoSummary {
  kind: CodexErrorInfoKind;
  /**
   * Present when a transport variant, or a variant newer than
   * `CODEX_ERROR_INFO_KINDS` (`kind: 'other'`, since 0.33.0), carried a
   * valid `httpStatusCode`.
   */
  httpStatusCode?: number;
  /**
   * The variant name exactly as received, set only when `kind` is `'other'`
   * because the variant is newer than `CODEX_ERROR_INFO_KINDS` (Codex itself
   * decodes unknown variants as `Other`). Never set for a literal `"other"`.
   */
  rawKind?: string;
}

export interface ProviderFailureEvidence {
  source: (typeof PROVIDER_FAILURE_EVIDENCE_SOURCES)[number];
  rule: ProviderFailureCode;
  checkedAt?: string;
  /** Present only when a Codex `codexErrorInfo` decided the rule. */
  codexErrorInfo?: CodexErrorInfoKind;
}

/** Safe diagnostic projection. No raw error text, request data, or credentials. */
export interface ProviderFailureDiagnosis {
  provider: AccountProviderId;
  credentialKind: ProviderCredentialKind;
  diagnosis: ProviderFailureCode;
  recovery: ProviderRecoveryAction;
  /**
   * Whether sending the same request again, unchanged and after any
   * `retryAfter`, can reasonably succeed. True for a rate limit that will
   * lift, overload, an unavailable service (5xx), a timeout, or a failed
   * connection. False for authentication, missing runtime or configuration,
   * execution policy, an invalid provider session, context overflow, an
   * unavailable model, a usage quota exhausted with no known reset, and
   * unknown failures. Conservative:
   * a hint for retry policy, not a promise. The caller still decides whether
   * a repeat is safe (idempotency, output already delivered).
   *
   * Always set by `diagnoseProviderFailure()` since 0.29.0; optional in the
   * type so diagnoses stored or built by older producers stay valid.
   */
  retryable?: boolean;
  evidence: ProviderFailureEvidence[];
  authentication?: ProviderAuthenticationEvidence;
  httpStatus?: number;
  retryAfter?: ProviderRetryAfter;
}

function read(value: unknown, key: string): unknown {
  try {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 16_384) : '';
}

function statusNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 100 && number <= 599
    ? number
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 64 &&
    /^(?:\d{4}-\d{2}-\d{2}T|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function retryAfter(value: unknown): ProviderRetryAfter | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const delayMs = Number(value) * 1000;
    return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= Number.MAX_SAFE_INTEGER
      ? { kind: 'delay', delayMs }
      : undefined;
  }
  const at = timestamp(value);
  return at ? { kind: 'date', at } : undefined;
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CODEX_ERROR_INFO_BY_KEY = new Map<string, CodexErrorInfoKind>(
  CODEX_ERROR_INFO_KINDS.map((kind) => [compactKey(kind), kind]),
);

/** Shape of a variant name Codex could add later: an identifier, camel or snake case. */
const CODEX_VARIANT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Decode one Codex `codexErrorInfo` value: a string variant
 * (`"serverOverloaded"`, `"usage_limit_exceeded"`) or an object variant
 * (`{ "httpConnectionFailed": { "httpStatusCode": 503 } }`, snake_case keys
 * accepted). Like Codex, an unknown variant name (a string, or the only key
 * of an object) decodes as `{ kind: 'other', rawKind }`. Its payload is
 * discarded except a valid `httpStatusCode`, which is kept (since 0.33.0) so
 * the status can still classify the failure. Returns `undefined` for
 * anything else, including `null`.
 */
export function decodeCodexErrorInfo(value: unknown): CodexErrorInfoSummary | undefined {
  if (typeof value === 'string') {
    const kind = value.length <= 64 ? CODEX_ERROR_INFO_BY_KEY.get(compactKey(value)) : undefined;
    if (kind) return { kind };
    return CODEX_VARIANT_NAME.test(value) ? { kind: 'other', rawKind: value } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return undefined;
  }
  for (const key of keys.slice(0, 8)) {
    const kind = key.length <= 64 ? CODEX_ERROR_INFO_BY_KEY.get(compactKey(key)) : undefined;
    if (!kind) continue;
    const payload = read(value, key);
    const status = statusNumber(
      read(payload, 'httpStatusCode') ?? read(payload, 'http_status_code'),
    );
    return status === undefined ? { kind } : { kind, httpStatusCode: status };
  }
  if (keys.length === 1 && CODEX_VARIANT_NAME.test(keys[0])) {
    const payload = read(value, keys[0]);
    const status = statusNumber(
      read(payload, 'httpStatusCode') ?? read(payload, 'http_status_code'),
    );
    return status === undefined
      ? { kind: 'other', rawKind: keys[0] }
      : { kind: 'other', rawKind: keys[0], httpStatusCode: status };
  }
  return undefined;
}

function rejected(kind: ProviderCredentialKind): ProviderFailureCode {
  return kind === 'oauth'
    ? 'oauth_reauthentication_required'
    : kind === 'api-key'
      ? 'api_credentials_rejected'
      : 'authentication_rejected';
}

function classifyCode(code: string, kind: ProviderCredentialKind): ProviderFailureCode | undefined {
  switch (code.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    case 'missingcredentials':
    case 'notloggedin':
    case 'signedout':
      return 'missing_credentials';
    case 'invalidapikey':
    case 'apikeyrejected':
      return 'api_credentials_rejected';
    case 'oauthtokenexpired':
    case 'refreshtokenexpired':
    case 'refreshtokenreused':
    case 'invalidgrant':
      return 'oauth_reauthentication_required';
    case 'authenticationerror':
    case 'autherror':
    case 'invalidtoken':
    case 'tokenexpired':
    case 'unauthorized':
      return rejected(kind);
    case 'threadnotfound':
    case 'invalidthreadid':
    case 'conversationnotfound':
    case 'invalidconversation':
    case 'conversationexpired':
    case 'invalidsessionid':
      return 'invalid_provider_session';
    case 'executionpolicydenied':
    case 'sandboxdenied':
    case 'approvaldenied':
      return 'execution_policy_denied';
    case 'ratelimiterror':
    case 'ratelimitexceeded':
    case 'toomanyrequests':
      return 'rate_limited';
    case 'overloadederror':
    case 'serveroverloaded':
      return 'overloaded';
    case 'serviceunavailable':
    case 'internalservererror':
    case 'servererror':
      return 'service_unavailable';
    case 'timeouterror':
    case 'apiconnectiontimeouterror':
    case 'etimedout':
    case 'underrconnecttimeout':
    case 'underrheaderstimeout':
    case 'deadlineexceeded':
      return 'timeout';
    case 'econnreset':
    case 'econnrefused':
    case 'enotfound':
    case 'eaiagain':
    case 'enetunreach':
    case 'ehostunreach':
    case 'apiconnectionerror':
      return 'connection_failed';
    case 'runtimenotfound':
    case 'runtimeunavailable':
    case 'modulenotfound':
    case 'errmodulenotfound':
      return 'runtime_unavailable';
    case 'contextlengthexceeded':
    case 'contextwindowexceeded':
    case 'prompttoolong':
      return 'context_overflow';
    // OpenAI `model_not_found`; Anthropic's generic `not_found_error` is
    // left to the message rules, which require the model to be named.
    case 'modelnotfound':
    case 'modelnotfounderror':
      return 'model_unavailable';
    default:
      return undefined;
  }
}

function classifyStatus(
  status: number,
  kind: ProviderCredentialKind,
): ProviderFailureCode | undefined {
  if (status === 401) return rejected(kind);
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'service_unavailable';
  return undefined;
}

/**
 * Variants with no matching failure code (bad request, invalid prompt,
 * content policy, budget, other) stay unclassified and fall through to the
 * code, status and message rules.
 */
function classifyCodexErrorInfo(
  info: CodexErrorInfoSummary,
  kind: ProviderCredentialKind,
): ProviderFailureCode | undefined {
  switch (info.kind) {
    case 'usageLimitExceeded':
    case 'rateLimitExceeded':
      return 'rate_limited';
    case 'serverOverloaded':
    case 'flexUnavailable':
    case 'policyCapacityUnavailable':
      // Flex-tier or policy-restricted capacity is temporarily unavailable too.
      return 'overloaded';
    case 'tooManyDenials':
      // The turn hit Codex's limit on denied approvals.
      return 'execution_policy_denied';
    case 'internalServerError':
      return 'service_unavailable';
    case 'unauthorized':
      return rejected(kind);
    case 'contextWindowExceeded':
      return 'context_overflow';
    case 'modelNotFound':
      return 'model_unavailable';
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return info.httpStatusCode === undefined
        ? 'connection_failed'
        : classifyStatus(info.httpStatusCode, kind);
    default:
      return undefined;
  }
}

function isRetryable(
  code: ProviderFailureCode,
  quotaExhausted: boolean,
  retry: ProviderRetryAfter | undefined,
): boolean {
  switch (code) {
    case 'rate_limited':
      return !quotaExhausted || retry !== undefined;
    case 'overloaded':
    case 'service_unavailable':
    case 'timeout':
    case 'connection_failed':
      return true;
    default:
      return false;
  }
}

/**
 * Error text naming a model that is missing or out of reach. Literal patterns
 * (no top-level calls) so bundlers can drop them with the classifier. A model
 * id is `[A-Za-z0-9][\w.:/@-]{0,99}`, optionally quoted.
 */
const MODEL_UNAVAILABLE_MESSAGES: readonly RegExp[] = [
  /^\s*model:\s*\S+\s*$/i,
  /\bmodel\s+[`'"(]?[A-Za-z0-9][\w.:/@-]{0,99}[`'")]?\s+(?:does not exist|doesn't exist|is not found|not found|is not supported|is not available)\b/i,
  /[`'"][A-Za-z0-9][\w.:/@-]{0,99}[`'"]\s+model\s+(?:does not exist|doesn't exist|is not found|not found|is not supported|is not available)\b/i,
  /\bselected model\s*\([^)\s]{1,100}\)[^.]{0,40}\.?\s*it may not exist\b/i,
];

function classifyMessage(
  message: string,
  kind: ProviderCredentialKind,
): ProviderFailureCode | undefined {
  if (
    /\b(execution policy|sandbox policy|approval)\b.{0,60}\b(denied|blocked|rejected|not allowed)\b|\bdenied by policy\b/i.test(
      message,
    )
  )
    return 'execution_policy_denied';
  // Only explicit credential rejection outranks an overlapping conversation error.
  if (
    /\b(oauth (?:(?:access |refresh )?token|credentials?)|refresh token) (?:is |was |has (?:been )?)?(expired|invalid|rejected|revoked)\b/i.test(
      message,
    )
  )
    return 'oauth_reauthentication_required';
  if (
    /\b(thread|conversation|session id)\b.{0,60}\b(not found|invalid|expired|does not exist)\b|\b(invalid|expired) (thread|conversation|session id)\b/i.test(
      message,
    )
  )
    return 'invalid_provider_session';
  if (/\b(oauth|refresh token)\b.{0,60}\b(expired|invalid|rejected|revoked)\b/i.test(message))
    return 'oauth_reauthentication_required';
  if (
    /\b(api[ _-]?key)\b.{0,60}\b(invalid|incorrect|rejected|revoked|expired)\b|\b(invalid|incorrect|rejected) api[ _-]?key\b/i.test(
      message,
    )
  )
    return 'api_credentials_rejected';
  if (
    /\b(no|missing) (oauth |api[ _-]?key |authentication )?(credentials|token|api[ _-]?key)\b|\bnot (logged|signed) in\b|\bsigned out\b|\bapi[ _-]?key (not configured|not set)\b/i.test(
      message,
    )
  )
    return 'missing_credentials';
  if (
    /\b(authentication failed|invalid authentication|credentials (rejected|expired)|token (expired|rejected|invalid)|login (has |is )?expired|please re-?authenticate)\b/i.test(
      message,
    )
  )
    return rejected(kind);
  if (
    /\b(context (length|window).{0,40}(exceed|overflow)|prompt (is )?too long|maximum context length)\b/i.test(
      message,
    )
  )
    return 'context_overflow';
  if (/\b(overloaded|over capacity|server busy)\b/i.test(message)) return 'overloaded';
  if (/\b(rate[ _-]?limit|too many requests)\b/i.test(message)) return 'rate_limited';
  if (/\b(timed? ?out|deadline exceeded|etimedout)\b/i.test(message)) return 'timeout';
  if (/\b(service unavailable|bad gateway|internal server error)\b/i.test(message))
    return 'service_unavailable';
  if (
    /\b(enotfound|eai_again|econnreset|econnrefused|dns (failure|lookup failed)|fetch failed|network (error|unreachable)|connection (reset|refused|terminated|termination)|upstream connect error|socket hang up)\b/i.test(
      message,
    )
  )
    return 'connection_failed';
  if (
    /\b(claude|codex|cli|runtime|executable)\b.{0,60}\b(not found|not installed|unavailable|not executable)\b|\bspawn\s+\S+\s+(ENOENT|EACCES)\b/i.test(
      message,
    )
  )
    return 'runtime_unavailable';
  // A named model that is missing or out of reach, checked last so that a
  // transient, runtime or other failure merely mentioning a model keeps its
  // own diagnosis. The model must be named next to the phrase: Anthropic's
  // `not_found_error` text (`model: claude-…`), OpenAI's "The model `x` does
  // not exist or you do not have access to it", Claude Code's "selected model
  // (x) … may not exist", and Codex's "The 'x' model is not supported" for an
  // account.
  if (MODEL_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message)))
    return 'model_unavailable';
  return undefined;
}

function recovery(code: ProviderFailureCode, kind: ProviderCredentialKind): ProviderRecoveryAction {
  switch (code) {
    case 'missing_credentials':
      return kind === 'oauth'
        ? 'sign_in'
        : kind === 'api-key'
          ? 'update_credentials'
          : 'check_authentication';
    case 'oauth_reauthentication_required':
      return 'sign_in';
    case 'api_credentials_rejected':
      return 'update_credentials';
    case 'authentication_rejected':
      return 'check_authentication';
    case 'invalid_provider_session':
      return 'start_new_session';
    case 'connection_failed':
      return 'check_connection';
    case 'execution_policy_denied':
      return 'review_execution_policy';
    case 'runtime_unavailable':
      return 'repair_runtime';
    case 'context_overflow':
      return 'reduce_context';
    case 'model_unavailable':
      return 'choose_model';
    case 'unknown':
      return 'inspect_error';
    default:
      return 'retry_later';
  }
}

/**
 * Classify a caller-designated terminal failure without I/O or recovery actions.
 * Public status and runtime readiness do not establish request authentication.
 *
 * A Codex `codexErrorInfo` (or `codex_error_info`) on the error or on any
 * nested `error` / `cause` / `response` / `data` / `body` / `errors` entry is
 * structured evidence. It ranks ahead of the same object's `code` / `type` /
 * `name`, objects are read outer first, and every structured code ranks ahead
 * of HTTP status and message text. Its transport variants also supply
 * `httpStatus`.
 */
export function diagnoseProviderFailure(input: ProviderFailureInput): ProviderFailureDiagnosis {
  const codes: Array<string | CodexErrorInfoSummary> = [];
  const messages: string[] = [];
  const visited = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input.error, depth: 0 }];
  let httpStatus: number | undefined;
  let retry: ProviderRetryAfter | undefined;
  for (let index = 0; index < queue.length && index < 32; index++) {
    const { value, depth } = queue[index];
    if (typeof value === 'string') {
      messages.push(text(value));
      continue;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const codex = decodeCodexErrorInfo(
      read(value, 'codexErrorInfo') ?? read(value, 'codex_error_info'),
    );
    if (codex) codes.push(codex);
    for (const key of ['code', 'type', 'name']) codes.push(text(read(value, key)));
    messages.push(text(read(value, 'message')));
    for (const key of ['status', 'statusCode', 'httpStatus', 'status_code'])
      httpStatus ??= statusNumber(read(value, key));
    httpStatus ??= codex?.httpStatusCode;
    const headers = read(value, 'headers');
    const header =
      typeof Headers !== 'undefined' && headers instanceof Headers
        ? headers.get('retry-after')
        : (read(headers, 'retry-after') ?? read(headers, 'Retry-After'));
    retry ??= retryAfter(header);
    const delay = read(value, 'retryAfterMs');
    if (
      !retry &&
      typeof delay === 'number' &&
      Number.isFinite(delay) &&
      delay >= 0 &&
      delay <= Number.MAX_SAFE_INTEGER
    )
      retry = { kind: 'delay', delayMs: delay };
    // ENOENT by itself can be a missing document. Require a spawn operation.
    if (read(value, 'code') === 'ENOENT' && /^spawn\b/.test(text(read(value, 'syscall'))))
      codes.push('runtime_unavailable');
    if (depth < 5) {
      for (const key of ['error', 'cause', 'response', 'data', 'body']) {
        let nested = read(value, key);
        if (
          typeof nested === 'string' &&
          nested.length <= 16_384 &&
          nested.trim().startsWith('{')
        ) {
          try {
            nested = JSON.parse(nested);
          } catch {
            /* Keep message evidence. */
          }
        }
        if (nested != null) queue.push({ value: nested, depth: depth + 1 });
      }
      const errors = read(value, 'errors');
      if (Array.isArray(errors))
        for (const error of errors.slice(0, 8)) queue.push({ value: error, depth: depth + 1 });
    }
  }

  let authentication: ProviderAuthenticationEvidence | undefined;
  const auth = input.authentication;
  const checkedAt = timestamp(auth?.checkedAt);
  if (
    auth &&
    checkedAt &&
    ['oauth', 'api-key', 'unknown'].includes(auth.credentialKind) &&
    ['authenticated', 'missing', 'signed-out', 'expired', 'rejected', 'unknown'].includes(
      auth.state,
    ) &&
    ['local-check', 'provider-response'].includes(auth.source)
  ) {
    authentication = {
      credentialKind: auth.credentialKind,
      state: auth.state,
      checkedAt,
      source: auth.source,
    };
  }

  let diagnosis: ProviderFailureCode | undefined;
  let codexErrorInfo: CodexErrorInfoKind | undefined;
  for (const code of codes) {
    if (typeof code === 'string') {
      diagnosis = classifyCode(code, input.credentialKind);
    } else {
      diagnosis = classifyCodexErrorInfo(code, input.credentialKind);
      if (diagnosis) codexErrorInfo = code.kind;
    }
    if (diagnosis) break;
  }
  let source: ProviderFailureEvidence['source'] = 'structured-error';
  if (!diagnosis && httpStatus !== undefined) {
    diagnosis = classifyStatus(httpStatus, input.credentialKind);
    source = 'http-status';
  }
  if (!diagnosis) {
    source = 'message';
    for (const message of messages) {
      // Message HTTP codes must have an HTTP/status context, not just a stray number.
      const match = message.match(
        /\b(?:HTTP(?:\/\d(?:\.\d)?)?(?: error)?|(?:unexpected )?status(?: code)?|API error)\s*[:=]?\s*(\d{3})\b|\b(401|403|429|50[02349]|529)\s+(?:Unauthorized|Forbidden|Too Many Requests|Bad Gateway|Service Unavailable|Internal Server Error|Gateway Timeout)\b/i,
      );
      const status = match ? statusNumber(match[1] ?? match[2]) : undefined;
      // A structured status cannot be replaced by a contradictory status in prose.
      if (httpStatus === undefined && status !== undefined) {
        httpStatus = status;
        diagnosis = classifyStatus(status, input.credentialKind);
      }
      diagnosis ??= classifyMessage(message, input.credentialKind);
      if (diagnosis) break;
    }
  }
  if (!diagnosis && authentication && authentication.credentialKind === input.credentialKind) {
    if (authentication.state === 'missing' || authentication.state === 'signed-out')
      diagnosis = 'missing_credentials';
    if (authentication.state === 'expired' || authentication.state === 'rejected')
      diagnosis = rejected(input.credentialKind);
    if (diagnosis) source = 'authentication-check';
  }
  diagnosis ??= 'unknown';
  return {
    provider: input.provider,
    credentialKind: input.credentialKind,
    diagnosis,
    recovery: recovery(diagnosis, input.credentialKind),
    retryable: isRetryable(diagnosis, codexErrorInfo === 'usageLimitExceeded', retry),
    evidence:
      diagnosis === 'unknown'
        ? []
        : [
            {
              source,
              rule: diagnosis,
              ...(source === 'authentication-check'
                ? { checkedAt: authentication!.checkedAt }
                : {}),
              ...(codexErrorInfo ? { codexErrorInfo } : {}),
            },
          ],
    ...(authentication ? { authentication } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retry ? { retryAfter: retry } : {}),
  };
}
