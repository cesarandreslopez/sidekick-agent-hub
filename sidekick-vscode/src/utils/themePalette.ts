/**
 * Theme-aware palettes for the dashboard webviews.
 *
 * The context-attribution colors were a One Dark palette hardcoded in three
 * separate places, and the Chart.js axis, grid, and legend colors were
 * hardcoded dark-theme greys — low-contrast to illegible on every light theme.
 *
 * Everything here resolves through `--vscode-charts-*`, with the previous hex
 * values kept as `var()` fallbacks so a theme that does not define the chart
 * colors renders exactly as it did before.
 *
 * Deliberately free of any `vscode` import so it unit-tests without a mock.
 *
 * @module themePalette
 */

/** Attribution category -> CSS custom property holding its color. */
export const ATTRIBUTION_VARS = {
  systemPrompt: '--sk-attr-system',
  userMessages: '--sk-attr-user',
  assistantResponses: '--sk-attr-assistant',
  toolInputs: '--sk-attr-tool-in',
  toolOutputs: '--sk-attr-tool-out',
  thinking: '--sk-attr-thinking',
  other: '--sk-attr-other',
} as const;

export type AttributionCategory = keyof typeof ATTRIBUTION_VARS;

/** Display labels, shared by the legend and the per-turn chart. */
export const ATTRIBUTION_LABELS: Record<AttributionCategory, string> = {
  systemPrompt: 'System Prompt',
  userMessages: 'User Messages',
  assistantResponses: 'Assistant',
  toolInputs: 'Tool Inputs',
  toolOutputs: 'Tool Outputs',
  thinking: 'Thinking',
  other: 'Other',
};

/**
 * Theme-resolved value for each category.
 *
 * The seven categories map onto seven distinct VS Code chart colors, so no
 * two share a hue in any theme that defines them.
 */
const ATTRIBUTION_VALUES: Record<AttributionCategory, string> = {
  systemPrompt: 'var(--vscode-charts-red, #e06c75)',
  userMessages: 'var(--vscode-charts-blue, #61afef)',
  assistantResponses: 'var(--vscode-charts-green, #98c379)',
  toolInputs: 'var(--vscode-charts-purple, #c678dd)',
  toolOutputs: 'var(--vscode-charts-orange, #d19a66)',
  thinking: 'var(--vscode-charts-yellow, #56b6c2)',
  other: 'var(--vscode-descriptionForeground, #abb2bf)',
};

/** CSS custom property for a category, ready to drop into a style attribute. */
export function attributionVarRef(category: AttributionCategory): string {
  return `var(${ATTRIBUTION_VARS[category]})`;
}

/** Every category keyed by display label, for the chart's label-keyed lookup. */
export function attributionVarsByLabel(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(ATTRIBUTION_VARS) as AttributionCategory[]) {
    out[ATTRIBUTION_LABELS[key]] = ATTRIBUTION_VARS[key];
  }
  return out;
}

// ── Mind-map node palette ──

/** Node type -> CSS custom property, plus its display label and resolved value. */
const NODE_TYPES = {
  session: {
    label: 'Session',
    value: 'color-mix(in srgb, var(--vscode-charts-foreground, #9B9B9B) 60%, transparent)',
  },
  file: { label: 'File', value: 'var(--vscode-charts-blue, #4A90E2)' },
  tool: { label: 'Tool', value: 'var(--vscode-charts-green, #7ED321)' },
  todo: { label: 'TODO', value: 'var(--vscode-charts-yellow, #F5A623)' },
  subagent: { label: 'Subagent', value: 'var(--vscode-charts-purple, #BD10E0)' },
  url: {
    label: 'URL',
    // Blue-violet, not the blue/green midpoint: that mix is `plan`, and since
    // the fallback hex never applies in a theme that defines the chart colors,
    // sharing it would render the two node types in the identical color.
    value:
      'color-mix(in srgb, var(--vscode-charts-purple, #50E3C2) 40%, var(--vscode-charts-blue, #50E3C2))',
  },
  directory: {
    label: 'Directory',
    value:
      'color-mix(in srgb, var(--vscode-charts-orange, #8B572A) 70%, var(--vscode-charts-foreground, #8B572A))',
  },
  command: { label: 'Command', value: 'var(--vscode-charts-red, #D0021B)' },
  task: {
    label: 'Task',
    value:
      'color-mix(in srgb, var(--vscode-charts-red, #FF6B6B) 70%, var(--vscode-charts-orange, #FF6B6B))',
  },
  plan: {
    label: 'Plan',
    value:
      'color-mix(in srgb, var(--vscode-charts-blue, #00BCD4) 50%, var(--vscode-charts-green, #00BCD4))',
  },
  'plan-step': {
    label: 'Plan Step',
    value:
      'color-mix(in srgb, var(--vscode-charts-blue, #26C6DA) 40%, var(--vscode-charts-green, #26C6DA))',
  },
  'knowledge-note': { label: 'Note', value: 'var(--vscode-charts-orange, #FFB74D)' },
} as const;

export type NodeType = keyof typeof NODE_TYPES;

/** Node type -> CSS custom property name. */
export const NODE_TYPE_VARS = Object.fromEntries(
  Object.keys(NODE_TYPES).map((key) => [key, `--sk-node-${key}`]),
) as Record<NodeType, string>;

/** Plan-step complexity -> CSS custom property name. */
export const COMPLEXITY_VARS = {
  high: '--sk-complexity-high',
  medium: '--sk-complexity-medium',
  low: '--sk-complexity-low',
} as const;

// Shifted toward the chart foreground rather than left as the plain chart
// colors: `command`, `todo`, and `tool` already own red, yellow, and green
// unmixed, so a complexity-tinted plan step would otherwise be indistinguishable
// from a command, TODO, or tool node.
const COMPLEXITY_VALUES: Record<keyof typeof COMPLEXITY_VARS, string> = {
  high: 'color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 80%, var(--vscode-charts-foreground, #f14c4c))',
  medium:
    'color-mix(in srgb, var(--vscode-charts-yellow, #FFD700) 80%, var(--vscode-charts-foreground, #FFD700))',
  low: 'color-mix(in srgb, var(--vscode-charts-green, #73c991) 80%, var(--vscode-charts-foreground, #73c991))',
};

/** Node type -> `var()` reference, for the graph's fill lookup. */
export function nodeTypeVarRefs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(NODE_TYPES) as NodeType[]) {
    out[key] = `var(${NODE_TYPE_VARS[key]})`;
  }
  return out;
}

/** Complexity -> `var()` reference. */
export function complexityVarRefs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(COMPLEXITY_VARS) as (keyof typeof COMPLEXITY_VARS)[]) {
    out[key] = `var(${COMPLEXITY_VARS[key]})`;
  }
  return out;
}

/** `:root` block for the mind-map node and complexity palettes. */
export function getGraphPaletteCSS(): string {
  const nodes = (Object.keys(NODE_TYPES) as NodeType[])
    .map((key) => `      ${NODE_TYPE_VARS[key]}: ${NODE_TYPES[key].value};`)
    .join('\n');
  const complexity = (Object.keys(COMPLEXITY_VARS) as (keyof typeof COMPLEXITY_VARS)[])
    .map((key) => `      ${COMPLEXITY_VARS[key]}: ${COMPLEXITY_VALUES[key]};`)
    .join('\n');

  return `<style>
    :root {
${nodes}
${complexity}
    }
  </style>`;
}

/**
 * Legend markup, generated from the same map the graph reads.
 *
 * The hand-written legend listed ten of the twelve node types — `url` and
 * `plan-step` were undocumented — which is the kind of drift generating both
 * from one source makes impossible.
 *
 * Each row carries its node type in `data-node-type` so the hover-to-highlight
 * handler can read the type off the element instead of mapping DOM position
 * through a second, separately maintained list.
 */
export function getGraphLegendHtml(): string {
  return (Object.keys(NODE_TYPES) as NodeType[])
    .map(
      (key) =>
        `    <div class="legend-item" data-node-type="${key}">
      <span class="legend-dot" style="background: var(${NODE_TYPE_VARS[key]});"></span>
      <span>${NODE_TYPES[key].label}</span>
    </div>`,
    )
    .join('\n');
}

/**
 * `:root` block declaring every palette variable.
 *
 * Emitted alongside the shared design tokens. Because these are plain CSS
 * variables, everything styled through them re-themes with no JavaScript at
 * all — VS Code rewrites the variables live when the theme changes. Only
 * canvas-baked colors need explicit refreshing.
 */
export function getAttributionPaletteCSS(): string {
  const decls = (Object.keys(ATTRIBUTION_VARS) as AttributionCategory[])
    .map((key) => `      ${ATTRIBUTION_VARS[key]}: ${ATTRIBUTION_VALUES[key]};`)
    .join('\n');

  return `<style>
    :root {
${decls}
      /* Chart chrome. Previously hardcoded to dark-theme greys. */
      --sk-chart-tick: var(--vscode-descriptionForeground, #888);
      --sk-chart-label: var(--vscode-foreground, #ccc);
      --sk-chart-grid: var(--vscode-charts-lines, rgba(128, 128, 128, 0.15));
    }
  </style>`;
}
