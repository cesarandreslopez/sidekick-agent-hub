/**
 * Shared Sidekick branding for the terminal UI.
 */

/** Primary brand label for compact UI surfaces. */
export const BRAND_NAME = 'SIDEKICK';

/** Supporting descriptor used alongside the wordmark where space allows. */
export const BRAND_TAGLINE = 'Agent Hub';

/**
 * Compact ASCII wordmark sized to fit the existing 60-column overlay boxes.
 * Avoids heavy Unicode blocks so the logo stays stable across terminals.
 */
export const LOGO_ART = [
  '  {bold}{magenta-fg} ___ ___ ___  ___ _  _____ ___ _  __{/magenta-fg}{/bold}',
  '  {bold}{magenta-fg}/ __|_ _|   \\| __| |/ /_ _/ __| |/ /{/magenta-fg}{/bold}',
  '  {bold}{magenta-fg}\\__ \\| || |) | _|| \' < | | (__| \' < {/magenta-fg}{/bold}',
  '  {bold}{magenta-fg}|___/___|___/|___|_|\\_\\___\\___|_|\\_\\{/magenta-fg}{/bold}',
  `  {grey-fg}${BRAND_TAGLINE}{/grey-fg}`,
];

/** Single-line branded name for compact headers and status bars. */
export const BRAND_INLINE = `{bold}{magenta-fg}${BRAND_NAME}{/magenta-fg}{/bold}`;

/** Placeholder token replaced by the animated spinner frame at runtime. */
export const SPINNER_PLACEHOLDER = '{{SPINNER}}';
