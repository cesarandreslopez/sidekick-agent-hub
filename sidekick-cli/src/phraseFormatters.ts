import { getRandomPhrase } from 'sidekick-shared';

/** Random phrase wrapped in blessed `{grey-fg}` tags (for dashboard TUI). */
export function getRandomPhraseBlessedTag(): string {
  return `{grey-fg}${getRandomPhrase()}{/grey-fg}`;
}
