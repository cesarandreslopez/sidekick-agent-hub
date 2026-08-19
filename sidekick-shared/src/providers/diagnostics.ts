import type {
  ProviderId,
  ProviderOperationStatus,
  ProviderRuntimeStatus,
  SessionProviderDiagnostic,
  SessionProviderOptions,
} from './types';

const AVAILABLE_STATUS: ProviderRuntimeStatus = { available: true, kind: 'available' };

/** Small per-provider diagnostic state; it never stores transcript or environment contents. */
export class ProviderDiagnosticTracker {
  private lastEmittedSignature: string | null = null;
  private lastStatus: ProviderOperationStatus = {
    operation: 'construct',
    usable: true,
    degraded: false,
    runtimeStatus: AVAILABLE_STATUS,
    diagnostics: [],
  };

  constructor(
    private readonly providerId: ProviderId,
    private readonly options: SessionProviderOptions = {},
  ) {}

  available(operation: string): void {
    this.lastEmittedSignature = null;
    this.lastStatus = {
      operation,
      usable: true,
      degraded: false,
      runtimeStatus: AVAILABLE_STATUS,
      diagnostics: [],
    };
  }

  degraded(
    operation: string,
    runtimeStatus: ProviderRuntimeStatus,
    diagnostic: Omit<SessionProviderDiagnostic, 'providerId'>,
    usable = true,
  ): void {
    const value: SessionProviderDiagnostic = { providerId: this.providerId, ...diagnostic };
    this.lastStatus = {
      operation,
      usable,
      degraded: true,
      runtimeStatus,
      diagnostics: [value],
    };
    const signature = `${value.kind}\0${value.severity}\0${value.phase}\0${value.message}`;
    if (signature === this.lastEmittedSignature) return;
    this.lastEmittedSignature = signature;
    try {
      this.options.onDiagnostic?.(value);
    } catch {
      // Diagnostics are observational and cannot break provider operations.
    }
  }

  getLastOperationStatus(): ProviderOperationStatus {
    return {
      ...this.lastStatus,
      runtimeStatus: { ...this.lastStatus.runtimeStatus },
      diagnostics: [...this.lastStatus.diagnostics],
    };
  }
}

export function diagnosticFromRuntimeStatus(
  providerId: ProviderId,
  phase: SessionProviderDiagnostic['phase'],
  status: ProviderRuntimeStatus,
): SessionProviderDiagnostic | null {
  if (status.kind === 'available') return null;
  const kind = status.kind;
  return {
    providerId,
    kind,
    severity: status.kind === 'query_failed' ? 'error' : 'warning',
    phase,
    message: status.message ?? defaultRuntimeMessage(providerId, status.kind),
  };
}

function defaultRuntimeMessage(
  providerId: ProviderId,
  kind: Exclude<ProviderRuntimeStatus['kind'], 'available'>,
): string {
  switch (kind) {
    case 'home_unavailable':
      return `${providerId} data home is unavailable.`;
    case 'config_unreadable':
      return `${providerId} configuration is unreadable.`;
    case 'db_missing':
      return `${providerId} database is unavailable; file fallback is active.`;
    case 'sqlite_missing':
      return 'The sqlite3 executable is unavailable; file fallback is active.';
    case 'sqlite_blocked':
      return 'The sqlite3 executable could not be started; file fallback is active.';
    case 'query_failed':
      return `${providerId} database query failed; fallback data may be incomplete.`;
  }
}
