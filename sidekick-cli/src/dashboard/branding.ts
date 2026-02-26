/**
 * Sidekick branding — ASCII art, styled text, and color palette for the TUI.
 *
 * Alignment notes:
 *   - ⚡ (U+26A1) is double-width in most terminals, so it floats above
 *     the stalk rather than sitting inside a box
 *   - Body is 7 chars wide (cols 7-13), center at col 10
 *   - Antenna stalk │ and ⚡ are at col 10 (⚡ extends to col 11 = lightbulb effect)
 *   - </> sits left of the body on the top row
 */

import { getRandomPhraseBlessedTag } from '../phraseFormatters';

export const LOGO_ART = [
  '          {yellow-fg}⚡{/yellow-fg}',
  '          {magenta-fg}│{/magenta-fg}',
  '  {white-fg}</>{/white-fg}  {white-fg}╭──┴──╮{/white-fg}   {bold}{magenta-fg}S I D E K I C K{/magenta-fg}{/bold}',
  '       {white-fg}│{/white-fg} {cyan-fg}●{/cyan-fg} {cyan-fg}●{/cyan-fg} {white-fg}│{/white-fg}   {bold}Agent Hub{/bold}',
  '       {white-fg}│{/white-fg}  {green-fg}◡{/green-fg}  {white-fg}│{/white-fg}   {grey-fg}Terminal Dashboard{/grey-fg}',
  '       {white-fg}╰─────╯{/white-fg}',
];

/** Single-line branded name for the status bar. */
export const BRAND_INLINE = '{bold}{magenta-fg}⚡ SIDEKICK{/magenta-fg}{/bold}';

/** Tagline for status bar. */
export const TAGLINE = '{grey-fg}Agent Hub{/grey-fg}';

/** Placeholder token replaced by the animated spinner frame at runtime. */
export const SPINNER_PLACEHOLDER = '{{SPINNER}}';

/**
 * Splash screen content shown when waiting for a session or on first render.
 * The {{SPINNER}} placeholder is replaced by the Spinner animation at runtime.
 * Returns a fresh array each call so the random phrase changes per render.
 */
export function getSplashContent(): string[] {
  return [
    ...LOGO_ART,
    `  ${getRandomPhraseBlessedTag()}`,
    '',
    `  ${SPINNER_PLACEHOLDER} {grey-fg}Waiting for session events...{/grey-fg}`,
    '',
    '  {grey-fg}Navigate:{/grey-fg}  {bold}\u2190 \u2192{/bold} pages   {bold}1-5{/bold} jump   {bold}?{/bold} help   {bold}q{/bold} quit',
    '',
    '  {grey-fg}Start a Claude Code, OpenCode, or Codex session{/grey-fg}',
    '  {grey-fg}in another terminal and events will appear here.{/grey-fg}',
    '',
    '  {grey-fg}Or use {/grey-fg}{bold}--replay{/bold}{grey-fg} to replay an existing session.{/grey-fg}',
  ];
}

/**
 * Help overlay header with logo.
 */
export const HELP_HEADER = [
  ...LOGO_ART,
  '',
];
