import { describe, expect, it } from 'vitest';
import {
  busyInsights,
  busySnapshot,
  hostileSnapshot,
  NOW,
  quietSnapshot,
  thinkingSnapshot,
} from '../../testing/activityFixtures.setup';
import { ACTIVITY_STATIONS } from '../stations';
import { ACTIVITY_MAP_VIEWBOX, renderActivityMapSvg } from './svg';

const GOLDEN = '../../fixtures/activity/golden';

/** Every opened element is closed, in order (comments and declarations aside). */
function expectBalanced(svg: string): void {
  const stack: string[] = [];
  for (const match of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      expect(stack.pop(), `closing </${name}>`).toBe(name);
    } else {
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
}

describe('renderActivityMapSvg', () => {
  it('draws a busy session in each theme and motion (golden)', async () => {
    await expect(
      renderActivityMapSvg(busySnapshot(), { now: NOW, theme: 'dark', motion: 'full' }),
    ).toMatchFileSnapshot(`${GOLDEN}/busy-dark-full.svg`);
    await expect(
      renderActivityMapSvg(busySnapshot(), {
        now: NOW,
        theme: 'light',
        motion: 'none',
        insights: busyInsights(),
      }),
    ).toMatchFileSnapshot(`${GOLDEN}/busy-light-none.svg`);
    await expect(
      renderActivityMapSvg(thinkingSnapshot(), { now: NOW, theme: 'auto', motion: 'reduced' }),
    ).toMatchFileSnapshot(`${GOLDEN}/thinking-auto-reduced.svg`);
    await expect(
      renderActivityMapSvg(quietSnapshot(), {
        now: NOW,
        theme: 'css-vars',
        motion: 'full',
        size: 'responsive',
      }),
    ).toMatchFileSnapshot(`${GOLDEN}/quiet-css-vars.svg`);
  });

  it('is deterministic and well formed', () => {
    for (const snapshot of [
      busySnapshot(),
      quietSnapshot(),
      thinkingSnapshot(),
      hostileSnapshot(),
    ]) {
      for (const theme of ['dark', 'light', 'auto', 'css-vars'] as const) {
        for (const motion of ['full', 'reduced', 'none'] as const) {
          const a = renderActivityMapSvg(snapshot, {
            now: NOW,
            theme,
            motion,
            insights: busyInsights(),
          });
          const b = renderActivityMapSvg(snapshot, {
            now: NOW,
            theme,
            motion,
            insights: busyInsights(),
          });
          expect(a).toBe(b);
          expectBalanced(a);
          expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
          expect(a).toContain(
            `viewBox="0 0 ${ACTIVITY_MAP_VIEWBOX.width} ${ACTIVITY_MAP_VIEWBOX.height}"`,
          );
          expect(a).not.toMatch(/\sstyle="/);
          expect(a).not.toMatch(/NaN|undefined|Infinity/);
        }
      }
    }
  });

  it('draws every station once, with its data attribute, in ring order', () => {
    const svg = renderActivityMapSvg(quietSnapshot(), { now: NOW, theme: 'dark' });
    const order = [...svg.matchAll(/<g data-station="([a-z]+)">/g)].map((m) => m[1]);
    expect(order).toEqual([...ACTIVITY_STATIONS]);
  });

  it('emits no animation at all with motion none, and only opacity fades when reduced', () => {
    const none = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'none' });
    expect(none).not.toMatch(/<animate/);
    const reduced = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'reduced' });
    expect(reduced).not.toMatch(/<animateMotion|<animateTransform/);
    for (const m of reduced.matchAll(/<animate attributeName="([a-z-]+)"/g)) {
      expect(m[1]).toBe('opacity');
    }
    const full = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'full' });
    expect(full).toMatch(/<animateMotion/);
    expect(full).toMatch(/<animateTransform/);
  });

  it('starts flights in the past with negative begins, scaled by speed and shifted by the clock offset', () => {
    const svg = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'full' });
    // The edit started 200 ms ago: its pulse began at -0.200s.
    expect(svg).toContain('begin="-0.200s"');
    const fast = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'full', speed: 2 });
    expect(fast).toContain('begin="-0.100s" dur="0.400s"');
    const kept = renderActivityMapSvg(busySnapshot(), {
      now: NOW,
      motion: 'full',
      clockOffsetMs: 5_000,
    });
    expect(kept).toContain('begin="4.800s"');
  });

  it('leaves out one-shot animations that have ended', () => {
    const later = renderActivityMapSvg(quietSnapshot(), { now: NOW + 600_000, motion: 'full' });
    expect(later).not.toMatch(/fill="freeze"/);
    expect(later).not.toMatch(/<animateMotion/);
  });

  it('paints with attributes, classes or custom properties by theme', () => {
    const dark = renderActivityMapSvg(busySnapshot(), { now: NOW, theme: 'dark' });
    expect(dark).not.toMatch(/<style/);
    expect(dark).toContain('fill="#100c1d"');
    const light = renderActivityMapSvg(busySnapshot(), { now: NOW, theme: 'light' });
    expect(light).not.toMatch(/<style/);
    expect(light).toContain('fill="#f8f6fc"');
    const auto = renderActivityMapSvg(busySnapshot(), { now: NOW, theme: 'auto' });
    expect(auto).toContain('<style>@media (prefers-color-scheme: light){');
    expect(auto).toContain('fill="#100c1d"');
    expect(auto).toContain('class="sam-f-ground"');
    const vars = renderActivityMapSvg(busySnapshot(), { now: NOW, theme: 'css-vars' });
    expect(vars).toContain('var(--sidekick-activity-ground,#100c1d)');
    expect(vars).not.toMatch(/(fill|stroke)="#/);
    const bare = renderActivityMapSvg(busySnapshot(), {
      now: NOW,
      theme: 'css-vars',
      embedStyles: false,
      classPrefix: 'x',
    });
    expect(bare).not.toMatch(/<style/);
    expect(bare).toContain('class="x-f-ground"');
  });

  it('honours palette overrides', () => {
    const svg = renderActivityMapSvg(busySnapshot(), {
      now: NOW,
      theme: 'dark',
      palette: { ground: '#000000', stations: { shell: '#00ff00' } as never },
    });
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('#00ff00');
  });

  it('escapes every label and identifier', () => {
    const svg = renderActivityMapSvg(hostileSnapshot(), {
      now: NOW,
      theme: 'dark',
      motion: 'none',
      insights: busyInsights(),
    });
    expect(svg).not.toMatch(/<script|<\/svg><|<b>/);
    expect(svg).not.toMatch(/[\u0000\u0007]/);
    expect(svg).not.toContain('"><x');
    expect(svg).toContain('data-agent="a1&quot;&gt;&lt;x"');
    expectBalanced(svg);
  });

  it('names the map for assistive technology', () => {
    const svg = renderActivityMapSvg(busySnapshot(), {
      now: NOW,
      idPrefix: 'map-1',
      insights: busyInsights(),
    });
    expect(svg).toContain('role="img" aria-labelledby="map-1-title map-1-desc"');
    expect(svg).toContain(
      '<title id="map-1-title">Activity map. Files: activity/types.ts and 3 more · context 74%</title>',
    );
    expect(svg).toMatch(/<desc id="map-1-desc">93 calls at 10 stations/);
    const plain = renderActivityMapSvg(busySnapshot(), { now: NOW });
    expect(plain).toContain('aria-labelledby="activity-map-title"');
    expect(plain).not.toContain('<desc');
  });

  it('dims stations outside the highlight', () => {
    const svg = renderActivityMapSvg(busySnapshot(), {
      now: NOW,
      motion: 'none',
      highlight: 'shell',
    });
    expect(svg).toContain('<g opacity=".28"><g data-station="files">');
    expect(svg).not.toContain('<g opacity=".28"><g data-station="shell">');
  });

  it('turns the ring so that you sit at the bottom', () => {
    const cyOf = (svg: string, station: string): number => {
      const at = svg.indexOf(`<g data-station="${station}">`);
      return Number(/cy="([\d.]+)"/.exec(svg.slice(at))?.[1]);
    };
    const top = renderActivityMapSvg(quietSnapshot(), { now: NOW, layout: 'you-top' });
    const bottom = renderActivityMapSvg(quietSnapshot(), { now: NOW, layout: 'you-bottom' });
    expect(cyOf(top, 'you')).toBeLessThan(cyOf(top, 'network'));
    expect(cyOf(bottom, 'you')).toBeGreaterThan(cyOf(bottom, 'network'));
  });

  it('shows the core name, model and context, and sizes as asked', () => {
    const svg = renderActivityMapSvg(quietSnapshot(), { now: NOW, motion: 'none' });
    expect(svg).toContain('>CODEX</text>');
    expect(svg).toContain('>gpt-6.1 sol</text>');
    expect(svg).toContain('>23%</text>');
    expect(svg).toContain('width="960" height="920"');
    const named = renderActivityMapSvg(quietSnapshot(), {
      now: NOW,
      coreName: 'a very long core name',
      modelLabel: () => 'Model X',
      size: { width: 300, height: 290 },
    });
    expect(named).toContain('>a very lon</text>');
    expect(named).toContain('>Model X</text>');
    expect(named).toContain('width="300" height="290"');
  });

  it('marks faults, concurrency, retry streaks and loops', () => {
    const svg = renderActivityMapSvg(busySnapshot(), { now: NOW, motion: 'none', theme: 'dark' });
    expect(svg).toContain('×2</text>');
    expect(svg).toContain('data-pattern="retry-streak" data-station="shell"');
    expect(svg).toContain('↻3</text>');
    expect(svg).toContain('data-pattern="alternation" data-stations="files shell"');
    expect(svg).toContain('⇄×4</text>');
    expect(svg).toContain('<title>edit ↔ test loop ×4</title>');
    // Memory: asked, then pushed.
    expect(svg).toContain('3 <tspan fill="#4fe0c2">↓2</tspan>');
  });
});
