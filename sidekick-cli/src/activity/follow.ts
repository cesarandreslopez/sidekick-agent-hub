/**
 * `sidekick map --follow`: the activity map of the running session, live, in
 * a terminal of its own (a split beside the agent).
 *
 * Replays the followed session in full, then streams it. Unless a session is
 * pinned with `--session`, it moves to the newest session in the project as
 * one appears, and waits when there is none yet, so it can be started before
 * the agent. A pause freezes the view at a moment; the arrows move that moment
 * through the records kept so far.
 */

import * as path from 'path';
import React from 'react';
import {
  createWatcher,
  ObservedSessionCollector,
  observedSessionSourceFromProvider,
} from 'sidekick-shared';
import type { SessionEvent, SessionProviderBase } from 'sidekick-shared';
import { createDashboardSignalHandler } from '../commands/dashboardLifecycle';
import { buildFollowFrame } from './frame';
import type { FollowMode, FollowPanel } from './frame';
import { LiveActivity } from './liveActivity';
import type { LiveActivityRecorderOptions } from './liveActivity';
import { MapFollowApp } from './MapFollowApp';
import type { FollowKey } from './MapFollowApp';

export interface MapFollowOptions {
  provider: SessionProviderBase;
  workspacePath: string;
  /** Pin this session; otherwise follow the newest one. */
  sessionId?: string;
  recorder: LiveActivityRecorderOptions;
  coreName?: string;
}

/** Records kept for scrubbing back while paused. */
const KEEP_RECORDS = 20_000;
/** Redraw cadence while something moves, and while nothing does. */
const TICK_ACTIVE_MS = 250;
const TICK_IDLE_MS = 1_000;
/** A record newer than this keeps the fast cadence (pulses still landing). */
const RECENT_MS = 3_000;
const SESSION_CHANGE_DEBOUNCE_MS = 2_000;
const SESSION_CATCH_UP_POLL_MS = 30_000;

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Whether the frame changes on its own (running calls, spinners, fresh pulses). */
export function inMotion(live: LiveActivity, now: number): boolean {
  const snapshot = live.snapshot();
  if (snapshot.running.length > 0 || snapshot.turn.working) return true;
  return Number.isFinite(snapshot.at) && now - snapshot.at < RECENT_MS;
}

export async function runMapFollow(options: MapFollowOptions): Promise<void> {
  const { provider, workspacePath } = options;
  const live = new LiveActivity({
    providerId: provider.id,
    recorder: options.recorder,
    keepRecords: KEEP_RECORDS,
  });

  let watcher: ReturnType<typeof createWatcher>['watcher'] | null = null;
  let sessionPath: string | null = null;
  let sessionLabel: string | undefined;
  let panel: FollowPanel = 'feed';
  let paused = false;
  let cursor = 0;
  let notice: string | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let tick = 0;

  function showNotice(message: string): void {
    notice = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = undefined;
      requestRender();
    }, 6_000);
    noticeTimer.unref?.();
    requestRender();
  }

  function follow(target?: string): boolean {
    try {
      watcher?.stop();
    } catch {
      /* ignore */
    }
    watcher = null;
    try {
      const result = createWatcher({
        provider,
        workspacePath,
        ...(target ? { sessionId: target } : {}),
        includeTaskNotifications: true,
        includeActivitySignals: true,
        callbacks: {
          onEvent: () => {},
          onSessionEvent: (event: SessionEvent) => {
            if (stopped) return;
            if (live.observe(event) > 0) requestRender();
          },
          onReset: () => {
            if (stopped) return;
            live.reset();
            requestRender();
          },
          onError: (error: Error) => {
            if (!stopped) showNotice(`Session read error: ${error.message}`);
          },
        },
      });
      sessionPath = result.sessionPath;
      // The provider's id (a Codex rollout's uuid, not its `rollout-…` file name).
      const id = provider.getSessionId(result.sessionPath);
      sessionLabel = id.slice(0, 8);
      live.reset(id, provider.id);
      watcher = result.watcher;
      watcher.start(true);
      requestRender();
      return true;
    } catch {
      sessionPath = null;
      return false;
    }
  }

  function newestSession(): string | null {
    try {
      return provider.findAllSessions(workspacePath)[0] ?? null;
    } catch {
      return null;
    }
  }

  // ── Rendering ──
  const { render } = await import('ink');
  let instance: ReturnType<typeof render> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  function mode(): FollowMode {
    if (!sessionPath) return 'waiting';
    return paused ? 'paused' : 'live';
  }

  function frame(size: { columns: number; rows: number }) {
    const now = paused ? cursor : Date.now();
    const snapshot = sessionPath ? (paused ? live.snapshotAt(cursor) : live.snapshot()) : null;
    return buildFollowFrame({
      snapshot,
      // While paused the insights describe the cursor's moment, like the map.
      insights: sessionPath ? (paused ? live.insightsAt(cursor) : live.insights()) : null,
      now,
      width: size.columns,
      height: size.rows,
      panel,
      mode: mode(),
      providerLabel: PROVIDER_LABELS[provider.id] ?? provider.id,
      ...(sessionLabel ? { sessionLabel } : {}),
      ...(options.coreName ? { coreName: options.coreName } : {}),
      ...(notice ? { notice } : {}),
      workspaceLabel: path.basename(workspacePath),
    });
  }

  function element() {
    return React.createElement(MapFollowApp, { frame, onKey, tick });
  }

  function requestRender(): void {
    if (!instance || renderTimer || stopped) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      tick++;
      instance?.rerender(element());
    }, 100);
  }

  function seek(ms: number): void {
    const range = live.range();
    if (!range) return;
    if (!paused) {
      paused = true;
      cursor = Math.min(Date.now(), range.endMs);
    }
    cursor = Math.max(range.startMs, Math.min(range.endMs, cursor + ms));
    requestRender();
  }

  function onKey(key: FollowKey): void {
    switch (key.type) {
      case 'quit':
        quit();
        return;
      case 'feed':
        panel = panel === 'feed' ? 'none' : 'feed';
        break;
      case 'insights':
        panel = panel === 'insights' ? 'none' : 'insights';
        break;
      case 'pause':
        if (paused) paused = false;
        else if (sessionPath) {
          paused = true;
          const range = live.range();
          cursor = range ? Math.min(Date.now(), range.endMs) : Date.now();
        }
        break;
      case 'live':
        paused = false;
        break;
      case 'seek':
        seek(key.ms);
        return;
    }
    requestRender();
  }

  // ── Session following ──
  if (options.sessionId) {
    if (!follow(options.sessionId)) {
      process.stderr.write(`Session ${options.sessionId} not found for ${provider.displayName}.\n`);
      process.exitCode = 1;
      provider.dispose();
      return;
    }
  } else {
    follow();
  }

  const collector = options.sessionId
    ? null
    : new ObservedSessionCollector({
        sources: [
          observedSessionSourceFromProvider(provider, workspacePath, { observationOnly: true }),
        ],
      });
  const subscription = collector?.subscribe(
    (batch) => {
      if (stopped) return;
      const elsewhere = batch.changes.some(
        (change) => change.type !== 'removed' && change.reference.sourceKey !== sessionPath,
      );
      if (!elsewhere) return;
      const newest = newestSession();
      if (!newest || newest === sessionPath) return;
      // createWatcher matches sessions by the provider's id, not the file name.
      const id = provider.getSessionId(newest);
      if (follow(id)) {
        paused = false;
        showNotice(`Following the newer session ${id.slice(0, 8)}`);
      }
    },
    { debounceMs: SESSION_CHANGE_DEBOUNCE_MS, pollIntervalMs: SESSION_CATCH_UP_POLL_MS },
  );

  // Redraw on a clock while something moves (durations, spinners), slowly otherwise.
  let ticker: ReturnType<typeof setTimeout> | null = null;
  function scheduleTick(): void {
    if (stopped) return;
    const delay =
      !paused && sessionPath && inMotion(live, Date.now()) ? TICK_ACTIVE_MS : TICK_IDLE_MS;
    ticker = setTimeout(() => {
      if (!paused) requestRender();
      scheduleTick();
    }, delay);
  }

  function cleanup(): void {
    if (stopped) return;
    stopped = true;
    if (ticker) clearTimeout(ticker);
    if (renderTimer) clearTimeout(renderTimer);
    if (noticeTimer) clearTimeout(noticeTimer);
    try {
      subscription?.dispose();
    } catch {
      /* ignore */
    }
    try {
      collector?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      watcher?.stop();
    } catch {
      /* ignore */
    }
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
  }

  function quit(): void {
    cleanup();
    instance?.unmount();
  }

  instance = render(element(), { exitOnCtrlC: false, maxFps: 15 });
  scheduleTick();
  const onSignal = createDashboardSignalHandler(cleanup, () => instance?.unmount());
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await instance.waitUntilExit();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  cleanup();
}
