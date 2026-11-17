/**
 * Argv scanning shared by the two-stage entry point.
 *
 * `entry.ts` needs the command name before it decides whether to import
 * Commander and Ink at all, and `cli.ts` needs the same answer to decide which
 * startup side effects to run. Both previously carried their own copy of this
 * loop, which meant adding a global flag required editing both — and forgetting
 * one produced a wrong command token rather than an error.
 *
 * esbuild duplicates these few lines into each bundle, which is cheaper than
 * the drift and keeps `entry.ts` free of Commander.
 */

/** Global flags that consume the following argv entry as their value. */
const VALUE_FLAGS = ['--project', '--provider', '--output-file'] as const;

/** Global boolean flags, which never consume a value. */
const BOOLEAN_FLAGS = ['--json', '--no-color', '--offline'] as const;

/**
 * The first argv entry that names a command, skipping global flags.
 *
 * Returns `undefined` for a bare invocation and for flag-only invocations such
 * as `--help` and `--version`. Option *values* are never mistaken for the
 * command, so `sidekick --project /x dashboard` resolves to `dashboard` and
 * `sidekick tasks add today` resolves to `tasks`.
 */
export function firstCommandToken(args: string[]): string | undefined {
  const index = commandTokenIndex(args);
  return index === undefined ? undefined : args[index];
}

/**
 * True when the invocation is a plain `sidekick statusline`, the form Claude
 * Code runs on every prompt, which the launcher serves without loading
 * Commander. Anything else after the command (`--help`, a typo, an option the
 * fast path does not handle such as `--output-file`) goes through the full CLI,
 * which prints help or rejects it.
 */
export function isStatuslineInvocation(args: string[]): boolean {
  const index = commandTokenIndex(args);
  if (index === undefined || args[index] !== 'statusline') return false;
  if (
    args.some((argument) => argument === '--output-file' || argument.startsWith('--output-file='))
  ) {
    return false;
  }
  return args
    .slice(index + 1)
    .every((argument) => (BOOLEAN_FLAGS as readonly string[]).includes(argument));
}

function commandTokenIndex(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if ((BOOLEAN_FLAGS as readonly string[]).includes(argument)) continue;
    if ((VALUE_FLAGS as readonly string[]).includes(argument)) {
      index++;
      continue;
    }
    if (VALUE_FLAGS.some((flag) => argument.startsWith(`${flag}=`))) continue;
    return index;
  }
  return undefined;
}

/** The argv entries after the command token (`['add', 'x']` for `note add x`). */
export function argsAfterCommand(args: string[]): string[] {
  const index = commandTokenIndex(args);
  return index === undefined ? [] : args.slice(index + 1);
}
