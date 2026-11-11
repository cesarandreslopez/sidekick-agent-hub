/**
 * File paths named by an `apply_patch` envelope. Pure; split out of the
 * Codex parser so lean entry points can read patches without loading it.
 *
 * @module parsers/patchPaths
 */

/**
 * Extracts file paths from an apply_patch input string.
 * Matches lines like: `*** Add File: src/math.ts` or `*** Update File: src/index.ts`
 */
export function extractPatchFilePaths(input: string): string[] {
  const paths: string[] = [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}
