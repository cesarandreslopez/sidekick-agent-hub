import { getRandomPhrase } from 'sidekick-shared';

/** Random phrase wrapped in dim grey ANSI escape codes (for plain text CLI output). */
export function getRandomPhraseColored(): string {
  return `\x1b[2;90m${getRandomPhrase()}\x1b[0m`;
}

/** Random phrase wrapped in blessed `{grey-fg}` tags (for dashboard TUI). */
export function getRandomPhraseBlessedTag(): string {
  return `{grey-fg}${getRandomPhrase()}{/grey-fg}`;
}
