export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message}\n`;
}
