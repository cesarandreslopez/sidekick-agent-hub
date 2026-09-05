import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _emitAccountsChanged,
  _onRawAccountsChanged,
  type AccountChangeReason,
} from './accountChangeSignal';
import { getActiveAccountStatus, type ActiveAccountStatus } from './accountStatus';
import { getAccountsDir } from './accountRegistry';
import { getSystemCodexHome } from './codexProfiles';
import type { Disposable } from './quotaPoller';

export interface AccountsChangedEvent {
  reason: AccountChangeReason;
  status: ActiveAccountStatus;
}

export interface OnAccountsChangedOptions {
  /** Emit the current status immediately after subscribing. */
  emitCurrent?: boolean;
  /** Catch-up poll for filesystems where watch delivery is unreliable. Default: 30s. */
  pollIntervalMs?: number;
}

const listeners = new Set<(event: AccountsChangedEvent) => void>();
let watchers: fs.FSWatcher[] = [];
let pollTimer: ReturnType<typeof setInterval> | undefined;
let stopRawListener: (() => void) | undefined;
let lastFingerprint: string | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
let activePollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

/**
 * Observe login, logout, and active-account switches. Local Sidekick mutations
 * signal immediately; filesystem watchers cover external CLIs; a low-frequency
 * catch-up poll protects network mounts and watcher-hostile filesystems.
 */
export function onAccountsChanged(
  listener: (event: AccountsChangedEvent) => void,
  options: OnAccountsChangedOptions = {},
): Disposable {
  listeners.add(listener);
  // The fastest interval any live subscriber asked for wins; a later, faster
  // subscriber restarts the timer rather than being silently ignored.
  const requestedPollMs = Math.max(1_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (!stopRawListener) {
    activePollIntervalMs = requestedPollMs;
    ensureMonitoring();
  } else if (requestedPollMs < activePollIntervalMs) {
    activePollIntervalMs = requestedPollMs;
    restartPollTimer();
  }
  if (options.emitCurrent) emitIfChanged('poll', true, listener);
  return {
    dispose: () => {
      listeners.delete(listener);
      if (listeners.size === 0) stopMonitoring();
    },
  };
}

function ensureMonitoring(): void {
  if (stopRawListener) return;
  lastFingerprint = fingerprint(getActiveAccountStatus());
  stopRawListener = _onRawAccountsChanged((reason) => scheduleCheck(reason));
  for (const target of watchTargets()) {
    try {
      const watcher = fs.watch(target, { persistent: false }, () => {
        scheduleCheck('filesystem');
      });
      watcher.on('error', () => {
        watchers = watchers.filter((candidate) => candidate !== watcher);
        try {
          watcher.close();
        } catch {
          // The catch-up poll remains active.
        }
      });
      watchers.push(watcher);
    } catch {
      // Missing/unwatchable directories are covered by the catch-up poll.
    }
  }
  startPollTimer();
}

function startPollTimer(): void {
  pollTimer = setInterval(() => emitIfChanged('poll'), activePollIntervalMs);
  pollTimer.unref?.();
}

function restartPollTimer(): void {
  if (pollTimer) clearInterval(pollTimer);
  startPollTimer();
}

function stopMonitoring(): void {
  stopRawListener?.();
  stopRawListener = undefined;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
  lastFingerprint = undefined;
  activePollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
}

function watchTargets(): string[] {
  return Array.from(
    new Set([getAccountsDir(), path.join(os.homedir(), '.claude'), getSystemCodexHome()]),
  );
}

function scheduleCheck(reason: AccountChangeReason): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    // Never force: watch targets include ~/.claude and the Codex home, whose
    // history files churn on every prompt. Only a real status change may wake
    // subscribers, or dormant quota pollers would poll on unrelated writes.
    emitIfChanged(reason);
  }, 25);
  debounceTimer.unref?.();
}

function emitIfChanged(
  reason: AccountChangeReason,
  force = false,
  singleListener?: (event: AccountsChangedEvent) => void,
): void {
  const status = getActiveAccountStatus();
  const nextFingerprint = fingerprint(status);
  if (!force && nextFingerprint === lastFingerprint) return;
  lastFingerprint = nextFingerprint;
  const event = { reason, status };
  const targets = singleListener ? [singleListener] : [...listeners];
  for (const listener of targets) {
    try {
      listener(event);
    } catch {
      // A host callback cannot stop monitoring.
    }
  }
}

function fingerprint(status: ActiveAccountStatus): string {
  return JSON.stringify(status);
}

/** Internal bridge for account mutations outside the registry module. */
export function _notifyAccountsChanged(): void {
  _emitAccountsChanged('local');
}
