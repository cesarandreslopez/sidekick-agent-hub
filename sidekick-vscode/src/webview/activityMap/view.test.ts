// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  createActivityState,
  applyActivityRecords,
  foldActivityFeed,
  renderActivityMapSvg,
  snapshotActivity,
  summarizeActivity,
} from 'sidekick-shared/activity';
import type { ActivityRecord } from 'sidekick-shared/activity';
import { MapView } from './view';
import { renderFeed } from './feed';
import { renderInsights, rankedStations } from './insights';
import { describeStation } from './tooltip';
import { resolveMotion } from './index';

const T0 = Date.parse('2026-11-01T12:00:00Z');

function scene() {
  const records: ActivityRecord[] = [
    { seq: 0, at: T0, kind: 'session', providerId: 'claude-code' },
    { seq: 1, at: T0, kind: 'prompt' },
    {
      seq: 2,
      at: T0 + 1_000,
      kind: 'toolStart',
      id: 'a',
      station: 'files',
      label: '<img src=x onerror=alert(1)>',
      tool: 'Read',
    },
    { seq: 3, at: T0 + 1_400, kind: 'toolEnd', id: 'a', outcome: 'ok', resultChars: 4_000 },
    {
      seq: 4,
      at: T0 + 2_000,
      kind: 'toolStart',
      id: 'b',
      station: 'shell',
      label: 'npm test',
      tool: 'Bash',
    },
    { seq: 5, at: T0 + 6_000, kind: 'toolEnd', id: 'b', outcome: 'error' },
    {
      seq: 6,
      at: T0 + 7_000,
      kind: 'toolStart',
      id: 'c',
      station: 'files',
      label: 'src/b.ts',
      tool: 'Read',
    },
  ];
  const state = createActivityState({ providerId: 'claude-code' });
  applyActivityRecords(state, records);
  return { snapshot: snapshotActivity(state), insights: summarizeActivity(state) };
}

describe('MapView', () => {
  it('swaps in the SVG, sets the accessible name and strips station titles', () => {
    const container = document.createElement('div');
    const tooltip = document.createElement('div');
    document.body.append(container, tooltip);
    const onSelect = vi.fn();
    const view = new MapView(container, tooltip, { onSelect, describe: () => 'Files\n2 calls' });
    const { snapshot, insights } = scene();
    const svg = renderActivityMapSvg(snapshot, {
      now: T0 + 8_000,
      theme: 'css-vars',
      embedStyles: false,
      size: 'responsive',
      idPrefix: 'am',
      insights,
    });
    view.render(svg, 'Files: src/b.ts');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.getAttribute('aria-label')).toBe('Files: src/b.ts');
    expect(container.querySelectorAll('[data-station] > title')).toHaveLength(0);

    const files = container.querySelector('[data-station="files"]');
    expect(files).not.toBeNull();
    files!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('files');

    // A hostile label is text inside the SVG, never markup.
    expect(container.querySelector('img')).toBeNull();
    view.setPaused(true);
    view.render(svg, 'Files: src/b.ts');
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('feed and insights', () => {
  it('renders feed rows as text, newest first, with running and fault marks', () => {
    const { snapshot } = scene();
    const list = document.createElement('ol');
    renderFeed(list, foldActivityFeed(snapshot.entries, { max: 10 }), T0 + 8_000);
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].dataset.state).toBe('running');
    expect(rows[0].textContent).toContain('src/b.ts');
    expect(rows.some((row) => row.dataset.state === 'fault')).toBe(true);
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');

    const empty = document.createElement('ol');
    renderFeed(empty, [], T0);
    expect(empty.textContent).toContain('Nothing yet.');
  });

  it('renders the station table as toggle buttons and reports clicks', () => {
    const { insights } = scene();
    const container = document.createElement('div');
    const onSelectStation = vi.fn();
    renderInsights(container, insights, 'shell', { onSelectStation, onSelectPattern: vi.fn() });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button.am-row'));
    expect(buttons.map((b) => b.dataset.station)).toEqual(
      rankedStations(insights).map((s) => s.id),
    );
    const shell = buttons.find((b) => b.dataset.station === 'shell')!;
    expect(shell.getAttribute('aria-pressed')).toBe('true');
    expect(shell.getAttribute('aria-label')).toContain('1 faults');
    shell.click();
    expect(onSelectStation).toHaveBeenCalledWith('shell');
    expect(container.querySelector('.am-summary')?.textContent).toBeTruthy();
  });

  it('describes a station for its tooltip', () => {
    const { snapshot, insights } = scene();
    const text = describeStation('files', snapshot, insights);
    expect(text.split('\n')[0]).toBe('Files');
    expect(text).toContain('2 calls');
    expect(text).toContain('1 running now');
    expect(text).toContain('tokens of output into context');
  });
});

describe('resolveMotion', () => {
  const base = { reduceMotion: 'auto' as const, layout: 'you-top' as const, coreName: '' };
  it('honours an explicit setting first, then workbench.reduceMotion, then the OS', () => {
    expect(resolveMotion({ ...base, motion: 'none' }, false)).toBe('none');
    expect(resolveMotion({ ...base, motion: 'auto', reduceMotion: 'on' }, false)).toBe('reduced');
    expect(resolveMotion({ ...base, motion: 'auto', reduceMotion: 'off' }, true)).toBe('full');
    expect(resolveMotion({ ...base, motion: 'auto' }, true)).toBe('reduced');
    expect(resolveMotion({ ...base, motion: 'auto' }, false)).toBe('full');
  });
});
