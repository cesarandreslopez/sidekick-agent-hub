export type AccountChangeReason = 'local' | 'filesystem' | 'poll';

const listeners = new Set<(reason: AccountChangeReason) => void>();

export function _onRawAccountsChanged(listener: (reason: AccountChangeReason) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _emitAccountsChanged(reason: AccountChangeReason): void {
  for (const listener of listeners) {
    try {
      listener(reason);
    } catch {
      // Account notifications are observational and cannot break mutations.
    }
  }
}
