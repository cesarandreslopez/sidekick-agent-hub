import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import { stripBlessedTags, visibleLength } from '../formatters';
import { MapPanel } from './MapPanel';
import { sampleActivity, T0 } from '../../activity/activityFixtures.testkit';

function metricsWithActivity(): DashboardMetrics {
  const { snapshot, insights } = sampleActivity();
  return { activity: { snapshot, insights } } as unknown as DashboardMetrics;
}

const staticData = {} as StaticData;
const now = () => T0 + 20_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('MapPanel', () => {
  it('lists an overview and the eleven stations, with counts and faults', () => {
    const panel = new MapPanel(() => {}, { now });
    const items = panel.getItems(metricsWithActivity());
    expect(items).toHaveLength(12);
    expect(items[0].id).toBe('overview');
    const shell = items.find((item) => item.id === 'station:shell');
    expect(stripBlessedTags(shell!.label)).toMatch(/Shell 2 !1/);
    expect(panel.getItems({} as DashboardMetrics)).toEqual([]);
  });

  it.each([60, 100])('renders both tabs within %i columns', (width) => {
    const panel = new MapPanel(() => {}, { now });
    const metrics = metricsWithActivity();
    for (const item of panel.getItems(metrics).slice(0, 5)) {
      for (const tab of panel.detailTabs) {
        const text = tab.render(item, metrics, staticData, { width, height: 40 });
        expect(text.length).toBeGreaterThan(0);
        for (const line of text.split('\n')) {
          expect(visibleLength(line), `${tab.label}/${item.id}: ${line}`).toBeLessThanOrEqual(
            width,
          );
        }
      }
    }
  });

  it('shows the map, the moment and the feed, filtered to a selected station', () => {
    const panel = new MapPanel(() => {}, { now });
    const metrics = metricsWithActivity();
    const [overview, , , , files] = panel.getItems(metrics);
    const map = stripBlessedTags(
      panel.detailTabs[0].render(overview, metrics, staticData, { width: 100, height: 40 }),
    );
    expect(map).toContain('CLAUDE');
    expect(map).toContain('Activity');
    expect(map).toContain('src/{index}.ts');
    const filtered = stripBlessedTags(
      panel.detailTabs[0].render(files, metrics, staticData, { width: 100, height: 40 }),
    );
    expect(filtered).toContain('Files activity');
    expect(filtered).not.toMatch(/Shell\s+npm test/);
  });

  it('shows where the time went and a station breakdown', () => {
    const panel = new MapPanel(() => {}, { now });
    const metrics = metricsWithActivity();
    const items = panel.getItems(metrics);
    const overview = stripBlessedTags(
      panel.detailTabs[1].render(items[0], metrics, staticData, { width: 100 }),
    );
    expect(overview).toContain('Where the time went');
    expect(overview).toContain('Shell');
    const shell = items.find((item) => item.id === 'station:shell')!;
    const detail = stripBlessedTags(
      panel.detailTabs[1].render(shell, metrics, staticData, { width: 100 }),
    );
    expect(detail).toContain('Calls');
    expect(detail).toContain('npm test');
    expect(detail).toContain('Recent faults');
  });

  it('redraws quickly while something runs and stops when deactivated', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const panel = new MapPanel(requestRender, { now });
    panel.getItems(metricsWithActivity()); // a call is still running in the sample
    panel.onActivate();
    vi.advanceTimersByTime(1_250);
    expect(requestRender).toHaveBeenCalledTimes(3);
    const version = panel.viewVersion;
    panel.onDeactivate();
    vi.advanceTimersByTime(10_000);
    expect(requestRender).toHaveBeenCalledTimes(3);
    expect(panel.viewVersion).toBe(version);
  });
});
