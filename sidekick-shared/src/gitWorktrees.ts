/**
 * A repository's worktrees, read from the filesystem the way git lays them
 * out, without running `git`.
 *
 * Handles the layouts `git worktree list` knows about: a checkout with a
 * `.git` directory, a linked worktree whose `.git` file points into
 * `<common>/worktrees/<name>`, a bare repository (asked about directly or
 * through a `.git` file such as `gitdir: ./.bare`), a `--separate-git-dir`
 * checkout, and worktrees recorded with relative paths
 * (`worktree.useRelativePaths`). A submodule resolves to itself, never to
 * its superproject.
 *
 * Reads are bounded: at most 4 KiB of any file and 1000 worktree entries.
 * Worktrees whose directory is gone (prunable) are left out. Never throws.
 *
 * @module gitWorktrees
 */

import * as fs from 'fs';
import * as path from 'path';

export type GitWorktreeKind = 'main' | 'linked' | 'bare';

export interface GitWorktree {
  /** The worktree's directory (for a bare repository, the repository itself). */
  path: string;
  kind: GitWorktreeKind;
  /** The worktree's own git directory (`<common>/worktrees/<name>` for a linked one). */
  gitDir: string;
}

export interface GitWorktreeLayout {
  /** The directory that was asked about, resolved. */
  input: string;
  /** Git directory of `input`: its `.git` directory, the target of its `.git` file, or itself. */
  gitDir: string;
  /** The repository's common git directory (objects, refs, config, `worktrees/`). */
  commonDir: string;
  /** `core.bare` of the common directory's config. */
  bare: boolean;
  /**
   * The main worktree (or the bare repository) first when it can be known,
   * then the linked worktrees by entry name. A `--separate-git-dir`
   * repository asked about from a linked worktree records no path back to
   * its main checkout, so that one is missing unless `core.worktree` names it.
   */
  worktrees: GitWorktree[];
}

/** Bytes read from any one git metadata file. */
export const GIT_METADATA_READ_BYTES = 4096;
/** Entries read from `<common>/worktrees/`. */
export const MAX_GIT_WORKTREE_ENTRIES = 1000;

function readHead(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(GIT_METADATA_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

function firstLine(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Target of a `gitdir: <path>` file, resolved against the file's directory. */
function gitdirFileTarget(filePath: string): string | null {
  const content = readHead(filePath);
  if (content === null) return null;
  const match = /^gitdir:\s*(.+)$/.exec(firstLine(content));
  if (!match) return null;
  const target = match[1].trim();
  return target ? path.resolve(path.dirname(filePath), target) : null;
}

/** A directory that is itself a git directory (a bare repository or a gitdir). */
function looksLikeGitDir(dir: string): boolean {
  return (
    isFile(path.join(dir, 'HEAD')) &&
    (isDirectory(path.join(dir, 'objects')) || isFile(path.join(dir, 'commondir')))
  );
}

interface CoreConfig {
  bare: boolean;
  worktree?: string;
}

function configBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return true; // `bare` with no value means true
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0', ''].includes(normalized)) return false;
  return undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** `core.bare` and `core.worktree` from the first 4 KiB of a git config. */
function readCoreConfig(commonDir: string): CoreConfig {
  const content = readHead(path.join(commonDir, 'config'));
  const core: CoreConfig = { bare: false };
  if (content === null) return core;
  let inCore = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)\s*(?:"[^"]*")?\s*\]/.exec(line);
    if (section) {
      inCore = section[1].toLowerCase() === 'core' && !line.includes('"');
      continue;
    }
    if (!inCore) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const key = entry[1].toLowerCase();
    if (key === 'bare') {
      const value = configBoolean(entry[2]);
      if (value !== undefined) core.bare = value;
    } else if (key === 'worktree' && entry[2] !== undefined) {
      const value = unquote(entry[2]);
      if (value) core.worktree = path.resolve(commonDir, value);
    }
  }
  return core;
}

/** The git directory of `input`, or null when it is not in a repository layout. */
function gitDirOf(input: string): string | null {
  const dotGit = path.join(input, '.git');
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) return dotGit;
  if (stat?.isFile()) {
    const target = gitdirFileTarget(dotGit);
    return target && isDirectory(target) ? target : null;
  }
  return looksLikeGitDir(input) ? input : null;
}

function commonDirOf(gitDir: string): string {
  const content = readHead(path.join(gitDir, 'commondir'));
  if (content !== null) {
    const recorded = firstLine(content);
    if (recorded) {
      const resolved = path.resolve(gitDir, recorded);
      if (isDirectory(resolved)) return resolved;
    }
  }
  // Hand-made layouts (and very old git) without a commondir file.
  const parent = path.dirname(gitDir);
  if (path.basename(parent) === 'worktrees') return path.dirname(parent);
  return gitDir;
}

function linkedWorktrees(commonDir: string): GitWorktree[] {
  const worktreesDir = path.join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir).sort();
  } catch {
    return [];
  }
  const worktrees: GitWorktree[] = [];
  for (const name of names.slice(0, MAX_GIT_WORKTREE_ENTRIES)) {
    const entryDir = path.join(worktreesDir, name);
    const content = readHead(path.join(entryDir, 'gitdir'));
    if (content === null) continue;
    const recorded = firstLine(content);
    if (!recorded) continue;
    // `<worktree>/.git`, absolute or relative to the entry directory.
    const worktreePath = path.dirname(path.resolve(entryDir, recorded));
    if (!isDirectory(worktreePath)) continue;
    worktrees.push({ path: worktreePath, kind: 'linked', gitDir: entryDir });
  }
  return worktrees;
}

/**
 * The worktrees of the repository `dir` belongs to, when `dir` is a
 * checkout (main or linked), a directory whose `.git` file names a git
 * directory, or a bare repository. Returns null for anything else,
 * including a plain subdirectory of a checkout (no upward search).
 */
export function resolveGitWorktrees(dir: string): GitWorktreeLayout | null {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const input = path.resolve(dir);
  const gitDir = gitDirOf(input);
  if (!gitDir) return null;
  const commonDir = commonDirOf(gitDir);
  const core = readCoreConfig(commonDir);
  const bare = core.bare;

  const worktrees: GitWorktree[] = [];
  if (bare) {
    worktrees.push({ path: commonDir, kind: 'bare', gitDir: commonDir });
  } else {
    let mainPath: string | undefined;
    if (gitDir === commonDir && gitDir !== input) {
      // The main checkout itself: a `.git` directory, `--separate-git-dir`,
      // or a submodule (whose git directory lives in the superproject).
      mainPath = input;
    } else if (path.basename(commonDir) === '.git') {
      mainPath = path.dirname(commonDir);
    } else if (core.worktree) {
      mainPath = core.worktree;
    }
    if (mainPath && isDirectory(mainPath)) {
      worktrees.push({ path: mainPath, kind: 'main', gitDir: commonDir });
    }
  }
  const seen = new Set(worktrees.map((worktree) => worktree.path));
  for (const worktree of linkedWorktrees(commonDir)) {
    if (seen.has(worktree.path)) continue;
    seen.add(worktree.path);
    worktrees.push(worktree);
  }
  return { input, gitDir, commonDir, bare, worktrees };
}
