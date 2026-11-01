import { diagnoseProviderFailure } from 'sidekick-shared';
import type { ProviderFailureDiagnosis, ProviderFailureInput } from 'sidekick-shared';

/** Extension copy; the shared diagnosis contains identifiers only. */
export function describeProviderFailure(result: ProviderFailureDiagnosis): string {
  const provider = result.provider === 'codex' ? 'Codex' : 'Claude';
  switch (result.recovery) {
    case 'sign_in':
      return result.diagnosis === 'missing_credentials'
        ? `${provider} is not signed in. Sign in before retrying.`
        : `${provider} OAuth sign-in has expired or was rejected. Sign in again before retrying.`;
    case 'update_credentials':
      return result.diagnosis === 'missing_credentials'
        ? `${provider} API key is not configured. Set the API key before retrying.`
        : `${provider} API credentials were rejected. Update the API key before retrying.`;
    case 'check_authentication':
      return `${provider} authentication needs attention. Check the credentials used by this request.`;
    case 'start_new_session':
      return `${provider} could not use this conversation. Start a new provider session.`;
    case 'check_connection':
      return `${provider} connection failed. Check your connection, proxy, or firewall before retrying.`;
    case 'review_execution_policy':
      return `${provider} execution was denied by policy. Review the requested operation and its permissions.`;
    case 'repair_runtime':
      return `${provider} local runtime is unavailable. Check the CLI installation and configured path.`;
    case 'reduce_context':
      return `${provider} context limit was exceeded. Reduce the input or start a new session.`;
    case 'retry_later':
      return result.diagnosis === 'timeout'
        ? `${provider} request timed out. Retry when ready.`
        : result.diagnosis === 'rate_limited' || result.diagnosis === 'overloaded'
          ? `${provider} is rate limited or overloaded. Wait before retrying.`
          : `${provider} service request was unavailable. Retry later.`;
    default:
      return `${provider} request failed for an unknown reason. Inspect the logs for details.`;
  }
}

export class ProviderRequestError extends Error {
  readonly diagnosis: ProviderFailureDiagnosis;
  constructor(input: ProviderFailureInput) {
    const diagnosis = diagnoseProviderFailure(input);
    super(describeProviderFailure(diagnosis), { cause: input.error });
    this.name = 'ProviderRequestError';
    this.diagnosis = diagnosis;
  }
}

/** A retry the error notification can offer, with how long the provider asked to wait. */
export interface ProviderRetryOffer {
  /** Milliseconds until the provider's `retryAfter`; 0 when none was given or it has passed. */
  waitMs: number;
  /** Sentence to append to the notification, '' when there is no wait. */
  hint: string;
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

/**
 * Whether a failed request is worth retrying unchanged, from the shared
 * diagnosis's `retryable` and `retryAfter`. Null when a retry would not help
 * (authentication, policy, context overflow, unknown) or the error carries no
 * diagnosis.
 */
export function providerRetryOffer(
  error: unknown,
  now: number = Date.now(),
): ProviderRetryOffer | null {
  const diagnosis = error instanceof ProviderRequestError ? error.diagnosis : undefined;
  if (diagnosis?.retryable !== true) return null;
  const after = diagnosis.retryAfter;
  const raw = !after ? 0 : after.kind === 'delay' ? after.delayMs : Date.parse(after.at) - now;
  const waitMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return { waitMs, hint: waitMs > 0 ? ` The provider asked to wait ${formatWait(waitMs)}.` : '' };
}
