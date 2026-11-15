/**
 * CSP regression guard for the inline-script webviews.
 *
 * Every webview here sets a nonce-based `script-src`, and some a nonce-based
 * `style-src`. A nonce whitelists `<script>`/`<style>` elements, never inline
 * `on*=` handler attributes, and never `style=` attributes unless the policy
 * also allows `'unsafe-inline'`. Both failures are silent in the webview: the
 * handler never runs and the style never applies. The markup and the scripts
 * that build markup at runtime live in the same template literals, so
 * scanning the source catches both.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

interface Surface {
  /** File whose template declares the Content-Security-Policy. */
  cspFile: string;
  /** Files that emit markup or DOM for that webview (includes `cspFile`). */
  sources: string[];
}

const SURFACES: Surface[] = [
  { cspFile: 'providers/ConversationViewProvider.ts', sources: [] },
  { cspFile: 'providers/ProjectTimelineViewProvider.ts', sources: [] },
  { cspFile: 'providers/MindMapViewProvider.ts', sources: ['utils/themePalette.ts'] },
  { cspFile: 'providers/TaskBoardViewProvider.ts', sources: [] },
  { cspFile: 'providers/PlanBoardViewProvider.ts', sources: [] },
  { cspFile: 'providers/ToolInspectorProvider.ts', sources: [] },
  { cspFile: 'providers/ExplainViewProvider.ts', sources: ['webview/explain.ts'] },
  { cspFile: 'providers/ErrorViewProvider.ts', sources: ['webview/error.ts'] },
  { cspFile: 'providers/MonitoringDisabledViewProvider.ts', sources: [] },
  {
    cspFile: 'providers/activityMapTemplate.ts',
    sources: fs
      .readdirSync(path.join(__dirname, '..', 'webview', 'activityMap'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `webview/activityMap/${f}`),
  },
];

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** `on*="…"` / `on*='…'` attributes, including inside JS string concatenation. */
const INLINE_HANDLER = /\son[a-z]+=\\?["']/g;
/** `style="…"` attributes and `setAttribute('style', …)`. */
const INLINE_STYLE = /\sstyle=\\?["']|setAttribute\(\s*['"]style['"]/g;

function styleSrcAllowsInline(source: string): boolean {
  const csp = /Content-Security-Policy"[\s\S]*?content="([\s\S]*?)"/.exec(source)?.[1] ?? '';
  const styleSrc = /style-src([^;]*)/.exec(csp)?.[1] ?? '';
  // A nonce or hash in the same directive makes browsers ignore 'unsafe-inline'.
  return styleSrc.includes("'unsafe-inline'") && !/'nonce-|'sha(256|384|512)-/.test(styleSrc);
}

function offendingLines(source: string, pattern: RegExp): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    })
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe('webview CSP guard', () => {
  for (const surface of SURFACES) {
    const files = [surface.cspFile, ...surface.sources];
    const cspSource = read(surface.cspFile);
    const allowsInlineStyle = styleSrcAllowsInline(cspSource);

    it(`${surface.cspFile} declares a nonce-based script-src`, () => {
      expect(cspSource).toMatch(/script-src[^;]*'nonce-/);
      expect(cspSource).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    for (const file of files) {
      it(`${file} has no inline event handler attributes`, () => {
        expect(offendingLines(read(file), INLINE_HANDLER)).toEqual([]);
      });

      if (!allowsInlineStyle) {
        it(`${file} has no style attributes (its style-src has no 'unsafe-inline')`, () => {
          expect(offendingLines(read(file), INLINE_STYLE)).toEqual([]);
        });
      }
    }
  }
});
