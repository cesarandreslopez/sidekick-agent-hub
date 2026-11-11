// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ActivityMarker } from 'sidekick-shared/activity';
import { DENSITY_BUCKETS, ReplayControls } from './controls';

const T0 = Date.parse('2026-11-01T12:00:00Z');

function controls(): { replay: ReplayControls; strip: SVGSVGElement } {
  const strip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const replay = new ReplayControls(
    document.createElement('div'),
    document.createElement('button'),
    document.createElement('input'),
    strip,
    document.createElement('span'),
    [],
    { onToggle: vi.fn(), onSpeed: vi.fn(), onSeek: vi.fn() },
  );
  return { replay, strip };
}

describe('ReplayControls strip', () => {
  it('scans the log only when the key changes', () => {
    const { replay, strip } = controls();
    const density = vi.fn(() => {
      const counts = new Array<number>(DENSITY_BUCKETS).fill(0);
      counts[3] = 2;
      return counts;
    });
    const markers = vi.fn((): ActivityMarker[] => [{ at: T0 + 500, kind: 'fault' }]);

    // No range yet: nothing to draw, nothing scanned.
    replay.updateStrip('1:1', density, markers);
    expect(density).not.toHaveBeenCalled();

    replay.update({
      range: { startAt: T0, endAt: T0 + 1_000 },
      mode: 'paused',
      cursor: T0,
      speed: 1,
    });
    replay.updateStrip('1:1', density, markers);
    replay.updateStrip('1:1', density, markers);
    expect(density).toHaveBeenCalledTimes(1);
    expect(markers).toHaveBeenCalledTimes(1);
    expect(strip.querySelectorAll('.am-density')).toHaveLength(1);
    expect(strip.querySelectorAll('.am-tick-fault')).toHaveLength(1);

    replay.updateStrip('1:2', density, markers);
    expect(density).toHaveBeenCalledTimes(2);
    expect(markers).toHaveBeenCalledTimes(2);
  });
});
