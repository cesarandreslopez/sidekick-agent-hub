/**
 * What a failed command prints. A few errors from the shared library get the
 * CLI step that answers them, since the library cannot name it.
 */
export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errno = error as NodeJS.ErrnoException | null;
  if (errno?.code === 'ENOENT' && errno.syscall === 'open' && typeof errno.path === 'string') {
    return `Error: cannot write ${errno.path}: its folder does not exist.\n`;
  }
  const hints: string[] = [];
  if (/^Session \S+ not found\b/.test(message)) {
    hints.push('Run "sidekick dump --list" to see this project\'s session IDs.');
  }
  if (message.includes('No handoff URL template is configured')) {
    hints.push('Pass --url-template or set SIDEKICK_HANDOFF_URL_TEMPLATE.');
  }
  return `Error: ${message}\n${hints.map((hint) => `${hint}\n`).join('')}`;
}
