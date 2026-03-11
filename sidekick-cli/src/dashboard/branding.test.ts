import { describe, expect, it } from 'vitest';
import { BRAND_INLINE, BRAND_NAME, BRAND_TAGLINE, LOGO_ART } from './branding';

function stripBlessedTags(line: string): string {
  return line.replace(/\{[^}]+\}/g, '');
}

describe('branding', () => {
  it('uses the Sidekick brand name consistently', () => {
    expect(BRAND_NAME).toBe('SIDEKICK');
    expect(BRAND_INLINE).toContain(BRAND_NAME);
    expect(LOGO_ART.some(line => stripBlessedTags(line).includes(BRAND_TAGLINE))).toBe(true);
  });

  it('keeps every logo line within the overlay width budget', () => {
    for (const line of LOGO_ART) {
      expect(stripBlessedTags(line).length).toBeLessThanOrEqual(46);
    }
  });
});
