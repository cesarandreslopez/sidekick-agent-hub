import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_LABELS,
  COMPLEXITY_VARS,
  NODE_TYPE_VARS,
  complexityVarRefs,
  getGraphLegendHtml,
  getGraphPaletteCSS,
  nodeTypeVarRefs,
  ATTRIBUTION_VARS,
  attributionVarRef,
  attributionVarsByLabel,
  getAttributionPaletteCSS,
  type AttributionCategory,
} from './themePalette';

const CATEGORIES = Object.keys(ATTRIBUTION_VARS) as AttributionCategory[];

describe('themePalette', () => {
  it('covers all seven attribution categories', () => {
    expect(CATEGORIES).toHaveLength(7);
    for (const category of CATEGORIES) {
      expect(ATTRIBUTION_LABELS[category], `${category} has no label`).toBeTruthy();
    }
  });

  it('names every variable under the --sk- prefix', () => {
    for (const category of CATEGORIES) {
      expect(ATTRIBUTION_VARS[category]).toMatch(/^--sk-attr-[a-z-]+$/);
    }
  });

  it('declares every category in the :root block', () => {
    const css = getAttributionPaletteCSS();
    for (const category of CATEGORIES) {
      expect(css, `${category} missing from :root`).toContain(`${ATTRIBUTION_VARS[category]}:`);
    }
  });

  it('resolves every color through a VS Code variable with a hex fallback', () => {
    // The fallbacks are the previous hardcoded values, so a theme that does
    // not define the chart colors renders exactly as it did before.
    const css = getAttributionPaletteCSS();
    const declarations = css.match(/--sk-attr-[a-z-]+: ([^;]+);/g) ?? [];
    expect(declarations).toHaveLength(7);
    for (const declaration of declarations) {
      expect(declaration).toMatch(/var\(--vscode-[a-zA-Z-]+, (#[0-9a-f]{6})\)/);
    }
  });

  it('declares the chart chrome variables the canvas reads', () => {
    const css = getAttributionPaletteCSS();
    expect(css).toContain('--sk-chart-tick:');
    expect(css).toContain('--sk-chart-label:');
    expect(css).toContain('--sk-chart-grid:');
  });

  it('gives each category a distinct color source', () => {
    // Two categories resolving to the same variable would be
    // indistinguishable in the stacked chart.
    const css = getAttributionPaletteCSS();
    const sources = (css.match(/--sk-attr-[a-z-]+: var\((--vscode-[a-zA-Z-]+)/g) ?? []).map(
      (line) => line.split('var(')[1],
    );
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('maps display labels to variables for the webview lookup', () => {
    const byLabel = attributionVarsByLabel();
    expect(Object.keys(byLabel)).toHaveLength(7);
    expect(byLabel['System Prompt']).toBe('--sk-attr-system');
    expect(byLabel['Other']).toBe('--sk-attr-other');
  });

  it('emits var() references usable directly in a style attribute', () => {
    expect(attributionVarRef('thinking')).toBe('var(--sk-attr-thinking)');
  });
});

describe('mind-map palette', () => {
  it('declares every node type used by the graph', () => {
    const refs = nodeTypeVarRefs();
    expect(Object.keys(refs)).toHaveLength(12);
    for (const [type, ref] of Object.entries(refs)) {
      expect(ref, `${type} is not a var() reference`).toMatch(/^var\(--sk-node-[a-z-]+\)$/);
    }
  });

  it('generates a legend entry for every node type', () => {
    // The hand-written legend listed ten of twelve types — url and plan-step
    // were undocumented. Generating both from one map makes that impossible.
    const legend = getGraphLegendHtml();
    const entries = legend.match(/class="legend-item"/g) ?? [];
    expect(entries).toHaveLength(Object.keys(nodeTypeVarRefs()).length);
  });

  it('references only palette variables from the legend', () => {
    const legend = getGraphLegendHtml();
    expect(legend).not.toMatch(/background: #[0-9a-fA-F]{6}/);
    for (const name of Object.values(NODE_TYPE_VARS)) {
      expect(legend).toContain(`var(${name})`);
    }
  });

  it('declares every node and complexity variable in the :root block', () => {
    const css = getGraphPaletteCSS();
    for (const name of Object.values(NODE_TYPE_VARS)) {
      expect(css, `${name} missing`).toContain(`${name}:`);
    }
    for (const name of Object.values(COMPLEXITY_VARS)) {
      expect(css, `${name} missing`).toContain(`${name}:`);
    }
  });

  it('gives each node type a distinct color expression', () => {
    const css = getGraphPaletteCSS();
    const values = (css.match(/--sk-node-[a-z-]+: ([^;]+);/g) ?? []).map(
      (line) => line.split(': ')[1],
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('maps complexity levels to palette variables', () => {
    expect(complexityVarRefs()).toEqual({
      high: 'var(--sk-complexity-high)',
      medium: 'var(--sk-complexity-medium)',
      low: 'var(--sk-complexity-low)',
    });
  });
});
