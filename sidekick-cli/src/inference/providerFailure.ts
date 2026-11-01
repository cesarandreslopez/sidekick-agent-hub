import type { ProviderFailureDiagnosis } from 'sidekick-shared';

/** `Retry in 30s.` / `Retry after 14:05.` from the provider's retry-after, when it sent one. */
function retryAfterHint(result: ProviderFailureDiagnosis): string | undefined {
  const retry = result.retryAfter;
  if (!retry) return undefined;
  if (retry.kind === 'delay') {
    const seconds = Math.max(1, Math.ceil(retry.delayMs / 1000));
    return seconds >= 120 ? `Retry in ${Math.ceil(seconds / 60)}m.` : `Retry in ${seconds}s.`;
  }
  const at = new Date(retry.at);
  return Number.isNaN(at.getTime())
    ? undefined
    : `Retry after ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
}

/**
 * CLI copy for an already-terminal inference failure; performs no recovery.
 * A plain "retry" is only suggested when the diagnosis does not rule it out
 * (`retryable !== false`); other failures name what has to change first.
 */
export function describeInferenceFailure(result: ProviderFailureDiagnosis): string {
  const provider = result.provider === 'codex' ? 'Codex' : 'Claude';
  switch (result.recovery) {
    case 'sign_in':
      return result.diagnosis === 'missing_credentials'
        ? `${provider} is not signed in. Sign in with the provider CLI before retrying.`
        : `${provider} OAuth sign-in has expired or was rejected. Sign in again before retrying.`;
    case 'update_credentials':
      return result.diagnosis === 'missing_credentials'
        ? `${provider} API key is not configured. Set the API key before retrying.`
        : `${provider} API credentials were rejected. Update the API key before retrying.`;
    case 'check_authentication':
      return `${provider} authentication needs attention. Check the credentials used by this request.`;
    case 'start_new_session':
      return `${provider} conversation is invalid or expired. Start a new provider session.`;
    case 'check_connection':
      return `${provider} connection failed. Check the network, proxy, or firewall.`;
    case 'review_execution_policy':
      return `${provider} execution was denied by policy. Review the requested operation and permissions.`;
    case 'repair_runtime':
      return `${provider} runtime is unavailable. Check its installation and executable path.`;
    case 'reduce_context':
      return `${provider} context limit exceeded. Reduce the input or start a new session.`;
    case 'retry_later':
      // `retryable: false` here is a usage quota exhausted with no known
      // reset: sending the request again cannot succeed, so do not suggest it.
      if (result.retryable === false) {
        return `${provider} usage limit is exhausted and no reset time was reported. Wait for the limit to reset or switch accounts.`;
      }
      return result.diagnosis === 'timeout'
        ? `${provider} request timed out. Retry when ready.`
        : result.diagnosis === 'rate_limited' || result.diagnosis === 'overloaded'
          ? `${provider} is rate limited or overloaded. ${retryAfterHint(result) ?? 'Wait before retrying.'}`
          : `${provider} service request was unavailable. Retry later.`;
    default:
      return `${provider} request failed for an unknown reason. Inspect the error details.`;
  }
}
