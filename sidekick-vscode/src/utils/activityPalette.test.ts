import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATIONS, listActivityCssVariables } from 'sidekick-shared/activity';
import { getActivityPaletteCSS } from './themePalette';

/** Declarations inside the block whose selector is exactly `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no ${selector} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon > 0) out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return out;
}

describe('activity map palette for VS Code', () => {
  const css = getActivityPaletteCSS();
  const variables = listActivityCssVariables();

  it('declares every variable the renderer reads, for every theme kind', () => {
    for (const selector of [
      'body',
      'body.vscode-light',
      'body.vscode-high-contrast',
      'body.vscode-high-contrast-light',
    ]) {
      const decls = block(css, selector === 'body' ? '    body' : selector);
      for (const variable of variables) {
        if (selector === 'body' && !decls.has(variable.name)) {
          // The first `body` block only sets the surface; the dark palette follows.
          continue;
        }
        expect(decls.has(variable.name), `${selector} lacks ${variable.name}`).toBe(true);
      }
    }
    for (const variable of variables) expect(css).toContain(`${variable.name}:`);
  });

  it('keeps eleven distinct station hues in light and dark', () => {
    const light = block(css, 'body.vscode-light');
    const hues = ACTIVITY_STATIONS.map((station) =>
      light.get(`--sidekick-activity-station-${station}`),
    );
    expect(new Set(hues).size).toBe(ACTIVITY_STATIONS.length);
    for (const station of ACTIVITY_STATIONS) {
      expect(css).toContain(`--sidekick-activity-station-${station}:`);
    }
  });

  it('takes the background, text and fault colors from the VS Code theme', () => {
    const light = block(css, 'body.vscode-light');
    expect(light.get('--sidekick-activity-ground')).toContain('--sk-activity-surface');
    expect(light.get('--sidekick-activity-text')).toContain('--vscode-foreground');
    expect(light.get('--sidekick-activity-fault')).toContain('--vscode-errorForeground');
    expect(css).toContain("body[data-mode='panel']");
  });

  it('draws lines in the contrast border on high-contrast themes', () => {
    const hc = block(css, 'body.vscode-high-contrast');
    expect(hc.get('--sidekick-activity-line')).toContain('--vscode-contrastBorder');
    expect(hc.get('--sidekick-activity-spoke')).toContain('--vscode-contrastBorder');
  });
});
