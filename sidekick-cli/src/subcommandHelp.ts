/**
 * Help and typo handling for commands that group subcommands.
 *
 * Commander gives a parent command with its own action (`tasks`, `quota`,
 * `handoff`) "too many arguments" for `tasks ad foo`, and prints a parent
 * without one (`note`, `decision`) as help on stderr with exit 1. Both read
 * as failures of the tool rather than of the typing.
 */

import type { Command } from 'commander';

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** The subcommand a typo most likely meant, if any is close. */
export function suggestSubcommand(typed: string, names: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(typed.toLowerCase(), name.toLowerCase());
    if (
      distance <= Math.max(1, Math.floor(name.length / 3)) &&
      (!best || distance < best.distance)
    ) {
      best = { name, distance };
    }
  }
  return best?.name;
}

/** The message for a word that is not one of `parent`'s subcommands. */
export function unknownSubcommandMessage(parent: Command, typed: string): string {
  const names = parent.commands.map((command) => command.name());
  const suggestion = suggestSubcommand(typed, names);
  return (
    `error: unknown command '${typed}' for '${parent.name()}'` +
    (suggestion
      ? `\n(Did you mean ${suggestion}?)`
      : names.length
        ? `\n(Commands: ${names.join(', ')})`
        : '')
  );
}

/**
 * A parent with its own action takes no positional words, so a stray word is
 * a mistyped subcommand: report it as one instead of "too many arguments".
 */
export function rejectUnknownSubcommands(parent: Command): void {
  parent.allowExcessArguments(true);
  parent.hook('preAction', (_hooked, actionCommand) => {
    if (actionCommand !== parent || parent.args.length === 0) return;
    parent.error(unknownSubcommandMessage(parent, parent.args[0]));
  });
}

/**
 * A parent without an action prints its help on stdout with exit 0 when it is
 * run alone. Only registered when nothing follows it, so `note ad x` still
 * gets Commander's own "unknown command … (Did you mean add?)".
 */
export function helpWhenRunAlone(parent: Command, argsAfterCommand: readonly string[]): void {
  if (argsAfterCommand.length > 0) return;
  parent.action(() => {
    parent.outputHelp();
  });
}

/** Lists the global options (--json, --project, …) in every subcommand's help. */
export function showGlobalOptionsEverywhere(command: Command): void {
  for (const sub of command.commands) {
    sub.configureHelp({ showGlobalOptions: true });
    showGlobalOptionsEverywhere(sub);
  }
}
