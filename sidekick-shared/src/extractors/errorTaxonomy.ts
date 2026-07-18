/** Canonical error categories used across providers and Sidekick surfaces. */
export type ErrorCategory =
  | 'permission'
  | 'not_found'
  | 'timeout'
  | 'syntax'
  | 'exit_code'
  | 'tool_error'
  | 'other';

function stringifyError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Classifies provider and tool failures into the stable shared taxonomy. */
export function categorizeError(output: unknown, providerErrorType?: string): ErrorCategory {
  const type = (providerErrorType ?? '').toLowerCase();
  const text = `${type} ${stringifyError(output)}`.toLowerCase();

  if (
    type === 'autherror' ||
    /permission denied|not permitted|unauthori[sz]ed|forbidden|authentication|access denied/.test(
      text,
    )
  ) {
    return 'permission';
  }
  if (/not found|no such file|enoent|does not exist|unknown command/.test(text)) return 'not_found';
  if (/timeout|timed out|deadline exceeded|etimedout/.test(text)) return 'timeout';
  if (/syntax error|parse error|invalid syntax/.test(text)) return 'syntax';
  if (/exit[ _-]?code|non[- ]zero exit|process exited/.test(text)) return 'exit_code';
  if (
    type === 'apierror' ||
    type === 'outputlengtherror' ||
    /tool_use_error|tool error|output length|rate limit|retry attempt/.test(text)
  ) {
    return 'tool_error';
  }
  return 'other';
}

/** Produces the compact error label used by the extension and CLI. */
export function extractErrorMessage(content: unknown, toolName: string): string {
  let message = stringifyError(content) || 'Unknown error';
  message = message.replace(/<\/?tool_use_error>/g, '').trim();
  if (message.length > 150) message = `${message.slice(0, 147)}...`;
  return `${toolName}: ${message}`;
}
