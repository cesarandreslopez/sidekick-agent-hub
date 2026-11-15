import { describe, expect, it } from 'vitest';
import { getDesignTokenCSS } from './designTokens';

describe('getDesignTokenCSS', () => {
  it('makes the hidden attribute win over author display rules', () => {
    // .sk-empty-state, .am-controls and friends set display: flex/grid, which
    // would otherwise beat the browser's own [hidden] { display: none }.
    expect(getDesignTokenCSS()).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });
});
