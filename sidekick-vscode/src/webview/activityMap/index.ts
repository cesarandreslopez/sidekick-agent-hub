/**
 * Activity Map webview: the sidebar view and the pop-out panel.
 *
 * The host sends the activity log as records; this bundle folds them into a
 * timeline and draws the map with the shared renderer (`css-vars` theme, so
 * VS Code's theme colors apply). Live, it redraws when records arrive (SMIL
 * animates in between). Replaying, it redraws a few times a second with the
 * animation speed matched to playback; paused, it draws a still frame.
 *
 * Imports `sidekick-shared/activity` only (pure, filesystem-free).
 *
 * @module webview/activityMap
 */

import {
  ACTIVITY_STATIONS,
  describeActivityNow,
  foldActivityFeed,
  renderActivityMapSvg,
} from 'sidekick-shared/activity';
import type { ActivityMotion, ActivityPattern, ActivityStationId } from 'sidekick-shared/activity';
import { ACTIVITY_MAP_PROTOCOL } from '../../types/activityMap';
import type {
  ActivityMapHostMessage,
  ActivityMapViewOptions,
  ActivityMapWebviewMessage,
} from '../../types/activityMap';
import { HostClock } from './clock';
import { DENSITY_BUCKETS, ReplayControls } from './controls';
import { renderFeed } from './feed';
import { readActivityMapInit } from './init';
import { renderInsights } from './insights';
import { ActivityTimelineModel } from './model';
import { PlaybackController, type PlaybackSpeed } from './playback';
import { describeStation } from './tooltip';
import { MapView } from './view';

declare function acquireVsCodeApi(): {
  postMessage(message: ActivityMapWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface SavedState {
  station?: ActivityStationId;
  feedOpen?: boolean;
  insightsOpen?: boolean;
}

/** Motion to draw with, from the setting, `workbench.reduceMotion` and the OS preference. */
export function resolveMotion(
  options: ActivityMapViewOptions,
  prefersReducedMotion: boolean,
): ActivityMotion {
  if (options.motion !== 'auto') return options.motion;
  if (options.reduceMotion === 'on') return 'reduced';
  if (options.reduceMotion === 'off') return 'full';
  return prefersReducedMotion ? 'reduced' : 'full';
}

const PLAY_RENDER_MS = 250;
const LIVE_REFRESH_MS = 5_000;
const ANNOUNCE_MS = 5_000;

function main(): void {
  const vscode = acquireVsCodeApi();
  const init = readActivityMapInit(document);
  const panel = init.mode === 'panel';
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

  const mapEl = byId<HTMLElement>('am-map');
  const tooltipEl = byId<HTMLElement>('am-tooltip');
  const nowEl = byId<HTMLElement>('am-now');
  const announceEl = byId<HTMLElement>('am-announce');
  const feedEl = byId<HTMLElement>('am-feed');
  const insightsEl = byId<HTMLElement>('am-insights');
  const emptyEl = byId<HTMLElement>('am-empty');
  const mainEl = byId<HTMLElement>('am-main');
  const badgeEl = byId<HTMLElement>('am-badge');
  const sourceEl = byId<HTMLElement>('am-source');
  const feedSection = byId<HTMLDetailsElement>('am-feed-section');
  const insightsSection = byId<HTMLDetailsElement>('am-insights-section');
  if (!mapEl || !tooltipEl || !feedEl || !insightsEl) return;

  const saved = (vscode.getState() as SavedState | undefined) ?? {};
  let options = init.options;
  let selected: ActivityStationId | undefined = init.focus?.station ?? saved.station;
  if (feedSection && saved.feedOpen !== undefined) feedSection.open = saved.feedOpen;
  if (insightsSection && saved.insightsOpen !== undefined)
    insightsSection.open = saved.insightsOpen;

  const model = new ActivityTimelineModel();
  const clock = new HostClock();
  const playback = new PlaybackController(
    init.focus?.at !== undefined ? { at: init.focus.at } : undefined,
  );
  const reducedQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : undefined;

  const saveState = () =>
    vscode.setState({
      station: selected,
      feedOpen: feedSection?.open,
      insightsOpen: insightsSection?.open,
    } satisfies SavedState);

  const selectStation = (station: ActivityStationId | undefined) => {
    selected = selected === station ? undefined : station;
    saveState();
    scheduleRender();
  };

  const view = new MapView(mapEl, tooltipEl, {
    onSelect: (station) => selectStation(station),
    describe: (station) => {
      const at = playback.cursorAt();
      return describeStation(station, model.snapshotAt(at), model.insightsAt(at));
    },
  });

  const controls = panel ? makeControls() : undefined;

  function makeControls(): ReplayControls | undefined {
    const root = byId<HTMLElement>('am-controls');
    const play = byId<HTMLButtonElement>('am-play');
    const input = byId<HTMLInputElement>('am-range');
    const strip = document.getElementById('am-strip') as SVGSVGElement | null;
    const time = byId<HTMLElement>('am-time');
    if (!root || !play || !input || !strip || !time) return undefined;
    const speeds = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-speed]'));
    return new ReplayControls(root, play, input, strip, time, speeds, {
      onToggle: () => {
        playback.toggle(model.range());
        afterPlaybackChange();
      },
      onSpeed: (speed) => {
        playback.setSpeed(speed);
        afterPlaybackChange();
      },
      onSeek: (at) => {
        playback.seek(at, model.range());
        afterPlaybackChange();
      },
    });
  }

  // ── Rendering ──

  let frame = 0;
  let lastAnnounce = 0;
  let lastAnnounced = '';
  let lastPlayRender = 0;

  function scheduleRender(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function render(): void {
    const hasSession = model.hasSession;
    if (emptyEl) emptyEl.hidden = hasSession;
    if (mainEl) mainEl.hidden = !hasSession;
    if (badgeEl) {
      badgeEl.textContent = !hasSession
        ? '—'
        : model.live
          ? playback.mode === 'live'
            ? 'live'
            : 'replay'
          : 'ended';
      badgeEl.dataset.live = String(hasSession && model.live && playback.mode === 'live');
    }
    if (sourceEl) sourceEl.textContent = model.source?.label ?? '';
    if (!hasSession) {
      mapEl!.innerHTML = '';
      return;
    }

    const at = playback.cursorAt();
    const snapshot = model.snapshotAt(at);
    const insights = model.insightsAt(at);
    const following = playback.mode === 'live';
    // Live: host time, so pulses line up with the agent's clock. Replay: the cursor.
    const now = following ? (model.live ? clock.now() : snapshot.at) : (at ?? snapshot.at);
    const baseMotion = resolveMotion(options, reducedQuery?.matches === true);
    const motion: ActivityMotion =
      playback.mode === 'paused' || (following && !model.live) ? 'none' : baseMotion;
    const svg = renderActivityMapSvg(snapshot, {
      now,
      theme: 'css-vars',
      // The document carries the class rules once (activityMapStyles in the template).
      embedStyles: false,
      motion,
      layout: options.layout,
      ...(options.coreName ? { coreName: options.coreName } : {}),
      size: 'responsive',
      idPrefix: 'am',
      speed: playback.mode === 'playing' ? playback.state.speed : 1,
      insights,
      ...(selected ? { highlight: selected } : {}),
    });
    const label = describeActivityNow(snapshot, { now });
    view.render(svg, label);
    if (nowEl) nowEl.textContent = label;
    announce(label);

    if (!feedSection || feedSection.open) {
      renderFeed(
        feedEl!,
        foldActivityFeed(snapshot.entries, {
          max: panel ? 40 : 14,
          ...(selected ? { station: selected } : {}),
        }),
        now,
      );
    }
    if (!insightsSection || insightsSection.open) {
      renderInsights(
        insightsEl!,
        insights,
        selected,
        {
          onSelectStation: (station) => selectStation(station),
          onSelectPattern: (pattern) => focusPattern(pattern),
        },
        { summary: panel },
      );
    }
    if (controls) {
      const range = model.range();
      controls.update({
        range,
        mode: playback.mode,
        cursor: playback.state.cursor,
        speed: playback.state.speed,
      });
      controls.updateStrip(
        `${model.epoch}:${model.version}`,
        model.density(DENSITY_BUCKETS),
        model.markers(),
      );
    }
  }

  function announce(text: string): void {
    if (!announceEl || text === lastAnnounced) return;
    const now = Date.now();
    if (now - lastAnnounce < ANNOUNCE_MS) return;
    lastAnnounce = now;
    lastAnnounced = text;
    announceEl.textContent = text;
  }

  function focusPattern(pattern: ActivityPattern): void {
    const station = pattern.kind === 'retry-streak' ? pattern.station : pattern.stations[0];
    selected = station;
    saveState();
    if (panel) playback.seek(pattern.startAt, model.range());
    afterPlaybackChange();
  }

  // ── Playback loop ──

  let loop = 0;
  let lastTick = 0;

  function afterPlaybackChange(): void {
    if (playback.mode === 'playing') startLoop();
    else stopLoop();
    scheduleRender();
  }

  function startLoop(): void {
    if (loop) return;
    lastTick = performance.now();
    const step = (time: number) => {
      const elapsed = time - lastTick;
      lastTick = time;
      playback.tick(elapsed, model.range(), {
        live: model.live,
        nextRecordAfter: (at) => model.nextRecordAfter(at),
      });
      if (playback.mode !== 'playing') {
        loop = 0;
        scheduleRender();
        return;
      }
      if (time - lastPlayRender >= PLAY_RENDER_MS) {
        lastPlayRender = time;
        render();
      } else if (controls) {
        controls.update({
          range: model.range(),
          mode: playback.mode,
          cursor: playback.state.cursor,
          speed: playback.state.speed,
        });
      }
      loop = requestAnimationFrame(step);
    };
    loop = requestAnimationFrame(step);
  }

  function stopLoop(): void {
    if (loop) cancelAnimationFrame(loop);
    loop = 0;
  }

  // Live: an occasional redraw keeps the "now" line and running durations current.
  setInterval(() => {
    if (document.visibilityState !== 'hidden' && playback.mode === 'live' && model.live) {
      scheduleRender();
    }
  }, LIVE_REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    view.setPaused(hidden);
    if (hidden) stopLoop();
    else if (playback.mode === 'playing') startLoop();
    if (!hidden) scheduleRender();
  });
  reducedQuery?.addEventListener?.('change', () => scheduleRender());

  // ── Host messages ──

  const post = (message: ActivityMapWebviewMessage) => vscode.postMessage(message);

  window.addEventListener('message', (event: MessageEvent<ActivityMapHostMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'activity/init':
        clock.observe(message.hostNow);
        model.init(message);
        if (message.focus?.at !== undefined) playback.seek(message.focus.at, model.range());
        if (message.focus?.station) selected = message.focus.station;
        afterPlaybackChange();
        return;
      case 'activity/append': {
        clock.observe(message.hostNow);
        const result = model.append(message);
        if (result !== 'ok') {
          post({ type: 'activity/resync', reason: result });
          return;
        }
        scheduleRender();
        return;
      }
      case 'activity/state':
        clock.observe(message.hostNow);
        model.setLive(message.live);
        scheduleRender();
        return;
      case 'activity/options':
        options = message.options;
        scheduleRender();
        return;
      case 'activity/empty':
        model.clear();
        playback.goLive();
        stopLoop();
        scheduleRender();
        return;
      default:
        return;
    }
  });

  // ── Toolbar, sections, keys ──

  byId<HTMLButtonElement>('am-popout')?.addEventListener('click', () =>
    post({
      type: 'activity/popOut',
      ...(playback.cursorAt() !== undefined ? { at: playback.cursorAt() } : {}),
      ...(selected ? { station: selected } : {}),
    }),
  );
  byId<HTMLButtonElement>('am-export')?.addEventListener('click', () =>
    post({
      type: 'activity/export',
      ...(playback.cursorAt() !== undefined ? { at: playback.cursorAt() } : {}),
    }),
  );
  byId<HTMLButtonElement>('am-live')?.addEventListener('click', () => {
    playback.goLive();
    afterPlaybackChange();
  });
  for (const section of [feedSection, insightsSection]) {
    section?.addEventListener('toggle', () => {
      saveState();
      scheduleRender();
    });
  }

  if (panel) {
    document.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'BUTTON')) {
        if (event.key !== ' ' || target.tagName === 'INPUT') return;
      }
      const range = model.range();
      const speeds: Record<string, PlaybackSpeed> = { '1': 1, '2': 10, '3': 60 };
      if (event.key === ' ') {
        playback.toggle(range);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const delta = (event.shiftKey ? 60_000 : 5_000) * (event.key === 'ArrowLeft' ? -1 : 1);
        playback.step(delta, range);
      } else if (event.key === 'Home' && range) {
        playback.seek(range.startAt, range);
      } else if (event.key === 'End' && range) {
        playback.seek(range.endAt, range);
      } else if (event.key === 'l' || event.key === 'L') {
        playback.goLive();
      } else if (speeds[event.key]) {
        playback.setSpeed(speeds[event.key]);
      } else if (event.key === 'Escape') {
        selected = undefined;
        saveState();
      } else {
        return;
      }
      event.preventDefault();
      afterPlaybackChange();
    });
  }
  // Keyboard path to stations from the map itself: Escape clears the filter.
  mapEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selected) {
      selected = undefined;
      saveState();
      scheduleRender();
    }
  });

  // Unknown station ids from an old saved state are dropped.
  if (selected && !(ACTIVITY_STATIONS as readonly string[]).includes(selected))
    selected = undefined;

  post({ type: 'activity/ready', protocol: ACTIVITY_MAP_PROTOCOL });
  scheduleRender();
}

if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') {
  main();
}
