import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATIONS } from '../stations';
import {
  ACTIVITY_DARK_PALETTE,
  ACTIVITY_LIGHT_PALETTE,
  ACTIVITY_PALETTE_ROLES,
  activityMapStyles,
  listActivityCssVariables,
} from './palette';

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('activity palettes', () => {
  for (const [name, palette] of [
    ['dark', ACTIVITY_DARK_PALETTE],
    ['light', ACTIVITY_LIGHT_PALETTE],
  ] as const) {
    it(`${name}: every role and station has a color`, () => {
      for (const role of ACTIVITY_PALETTE_ROLES) expect(palette[role]).toMatch(/^#[0-9a-f]{6}$/);
      for (const station of ACTIVITY_STATIONS)
        expect(palette.stations[station]).toMatch(/^#[0-9a-f]{6}$/);
    });

    it(`${name}: station hues are distinct, never the fault red, and readable on the ground`, () => {
      const hues = ACTIVITY_STATIONS.map((s) => palette.stations[s]);
      expect(new Set(hues).size).toBe(hues.length);
      expect(hues).not.toContain(palette.fault);
      for (const hue of hues) expect(contrast(hue, palette.ground)).toBeGreaterThanOrEqual(3);
      expect(contrast(palette.text, palette.ground)).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.fault, palette.ground)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('listActivityCssVariables', () => {
  it('lists one custom property per role and per station, with both defaults', () => {
    const vars = listActivityCssVariables();
    expect(vars).toHaveLength(ACTIVITY_PALETTE_ROLES.length + ACTIVITY_STATIONS.length);
    expect(vars[0]).toEqual({
      name: '--sidekick-activity-ground',
      role: 'ground',
      dark: '#100c1d',
      light: '#f8f6fc',
    });
    expect(vars.find((v) => v.role === 'station-shell')?.name).toBe(
      '--sidekick-activity-station-shell',
    );
    expect(listActivityCssVariables({ varPrefix: '--x-' })[0].name).toBe('--x-ground');
  });
});

describe('activityMapStyles', () => {
  it('maps each paint class to its custom property with the dark fallback', () => {
    const css = activityMapStyles();
    expect(css).toContain('.sam-f-ground{fill:var(--sidekick-activity-ground,#100c1d)}');
    expect(css).toContain('.sam-s-st-shell{stroke:var(--sidekick-activity-station-shell,#9ad96b)}');
    expect(activityMapStyles({ classPrefix: 'm', varPrefix: '--v-' })).toContain(
      '.m-f-accent{fill:var(--v-accent,#a98bff)}',
    );
  });
});
