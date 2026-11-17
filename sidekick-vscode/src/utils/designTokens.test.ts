import { describe, expect, it } from 'vitest';
import { getDesignTokenCSS } from './designTokens';

describe('getDesignTokenCSS', () => {
  it('makes the hidden attribute win over author display rules', () => {
    // .sk-empty-state, .am-controls and friends set display: flex/grid, which
    // would otherwise beat the browser's own [hidden] { display: none }.
    expect(getDesignTokenCSS()).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it("honours VS Code's reduce-motion setting, scoped to the body class", () => {
    const css = getDesignTokenCSS();
    // Every selector in the rule is prefixed; a bare *::before would stop
    // animations for everyone.
    expect(css).toMatch(
      /body\.vscode-reduce-motion \*,\s*body\.vscode-reduce-motion \*::before,\s*body\.vscode-reduce-motion \*::after\s*\{[^}]*animation-duration: 0\.01ms/,
    );
  });
});
