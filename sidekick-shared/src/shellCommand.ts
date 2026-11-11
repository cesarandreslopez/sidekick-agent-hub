/**
 * Small shell-command helpers shared by the prompt signals and the activity
 * map: program names, shell-wrapper unwrapping, quoting, and splitting a
 * command line into the commands it runs.
 *
 * These read command *structure* only (which programs run); callers decide
 * what may be shown. Pure: no filesystem access. Browser-safe.
 *
 * @module shellCommand
 */

export const POSIX_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
]);
export const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell']);

/** `/usr/bin/zsh` → `zsh`, `C:\Windows\System32\cmd.exe` → `cmd`. */
export function programName(argv0: string): string {
  return (argv0.split(/[\\/]/).pop() ?? argv0).toLowerCase().replace(/\.exe$/, '');
}

/** An argv element as a POSIX shell would need it written. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a call ran, as a person would type it: a string as is; for an
 * argv, the script of a shell wrapper (`bash -lc <script>`, `pwsh -Command
 * …`, `cmd /c …`), else the arguments joined with shell quoting.
 */
export function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const argv = value.filter((part): part is string => typeof part === 'string');
  if (argv.length === 0) return undefined;
  const program = programName(argv[0]);
  if (POSIX_SHELLS.has(program) && argv.length >= 3 && /^-[a-z]*c$/.test(argv[1])) {
    return argv[2];
  }
  if (POWERSHELLS.has(program)) {
    const flag = argv.findIndex((arg, index) => index > 0 && /^-(?:command|c)$/i.test(arg));
    if (flag > 0 && flag + 1 < argv.length) return argv.slice(flag + 1).join(' ');
  }
  if (program === 'cmd') {
    const flag = argv.findIndex((arg, index) => index > 0 && /^\/c$/i.test(arg));
    if (flag > 0 && flag + 1 < argv.length) return argv.slice(flag + 1).join(' ');
  }
  return argv.map(shellQuote).join(' ');
}

/**
 * For a command string that is itself a shell wrapper (`bash -lc 'npm test'`,
 * `zsh -c "…"`), the script it runs with one layer of quotes removed;
 * otherwise the string unchanged.
 */
export function unwrapShellScript(command: string): string {
  const match = /^\s*(?:\S*[\\/])?(sh|bash|zsh|dash|fish|ksh)\s+-[a-z]*c\s+([\s\S]+)$/i.exec(
    command,
  );
  if (!match) return command;
  const script = match[2].trim();
  const quote = script[0];
  if ((quote === "'" || quote === '"') && script.endsWith(quote) && script.length >= 2) {
    return script.slice(1, -1);
  }
  return script;
}

const SPLIT_SHALLOW = /&&|\|\||;|\||\n/;
const SPLIT_DEEP = /&&|\|\||;|\||\n|\$\(|`|\(|\)/;

/**
 * The words of each command in a shell line, leading `NAME=value`
 * assignments taken off. Quotes stay on words: a quoted word is an argument.
 * `deep` also cuts at `$(…)`, backticks and parentheses, to find commands run
 * inside another; the pieces around them are then not commands.
 */
export function shellSegments(command: string, deep = false): string[][] {
  return command
    .split(deep ? SPLIT_DEEP : SPLIT_SHALLOW)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      let index = 0;
      while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index] ?? '')) index++;
      return words.slice(index);
    })
    .filter((words) => words.length > 0);
}

/** A word with its quotes removed and its directory part dropped (`"./bin/x"` → `x`). */
export function commandWord(word: string | undefined): string {
  if (!word) return '';
  const bare = word.replace(/["']/g, '');
  return programName(bare);
}
