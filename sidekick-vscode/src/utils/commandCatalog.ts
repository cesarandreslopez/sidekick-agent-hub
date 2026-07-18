export interface ManifestCommand {
  command: string;
  title: string;
  category?: string;
}

export interface CommandCatalogItem {
  label: string;
  description: string;
  command: string;
}

export function buildCommandCatalog(
  packageJson: unknown,
  excludedCommands: ReadonlySet<string> = new Set(),
): CommandCatalogItem[] {
  const contributes = (
    packageJson as {
      contributes?: {
        commands?: unknown;
        menus?: { commandPalette?: Array<{ command?: unknown; when?: unknown }> };
      };
    }
  )?.contributes;
  const commands = contributes?.commands;
  if (!Array.isArray(commands)) return [];
  const hiddenCommands = new Set(
    (contributes?.menus?.commandPalette ?? [])
      .filter((entry) => entry.when === 'false' && typeof entry.command === 'string')
      .map((entry) => entry.command as string),
  );
  return commands
    .filter(
      (entry): entry is ManifestCommand =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ManifestCommand).command === 'string' &&
        typeof (entry as ManifestCommand).title === 'string' &&
        !hiddenCommands.has((entry as ManifestCommand).command) &&
        !excludedCommands.has((entry as ManifestCommand).command),
    )
    .map((entry) => ({
      label: entry.title,
      description: entry.category ?? 'Sidekick',
      command: entry.command,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
