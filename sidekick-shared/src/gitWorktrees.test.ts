import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitWorktrees, type GitWorktreeLayout } from './gitWorktrees';
import { discoverWorktreeSiblings, resolveWorktreeMainRepo } from './parsers/sessionPathResolver';

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

let root: string;
let gitEnv: NodeJS.ProcessEnv;

/** Real git, isolated from the machine's system and global config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Sidekick Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function real(target: string): string {
  return fs.realpathSync(target);
}

/** `git worktree list --porcelain -z` as a realpath set of the worktrees that still exist. */
function gitList(cwd: string): string[] {
  const out = git(cwd, 'worktree', 'list', '--porcelain', '-z');
  return out
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
    .filter((dir) => fs.existsSync(dir))
    .map(real)
    .sort();
}

function ours(layout: GitWorktreeLayout | null): string[] {
  expect(layout).not.toBeNull();
  return layout!.worktrees.map((worktree) => real(worktree.path)).sort();
}

function commit(cwd: string): void {
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'init');
}

function newRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  commit(dir);
  return dir;
}

describe.skipIf(!hasGit)('resolveGitWorktrees (real git)', () => {
  beforeEach(() => {
    root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-git-worktrees-')));
    const emptyGlobal = path.join(root, 'empty.gitconfig');
    fs.writeFileSync(emptyGlobal, '');
    gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    );
    Object.assign(gitEnv, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGlobal,
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists a normal repository and its linked worktree from either checkout', () => {
    const repo = newRepo('repo');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', path.join(root, 'feature'));
    const feature = path.join(root, 'feature');

    const fromMain = resolveGitWorktrees(repo);
    expect(ours(fromMain)).toEqual(gitList(repo));
    expect(fromMain!.worktrees.map((worktree) => worktree.kind)).toEqual(['main', 'linked']);
    expect(fromMain!.bare).toBe(false);
    expect(real(fromMain!.commonDir)).toBe(real(path.join(repo, '.git')));

    const fromLinked = resolveGitWorktrees(feature);
    expect(ours(fromLinked)).toEqual(gitList(feature));
    expect(real(fromLinked!.gitDir)).toBe(real(path.join(repo, '.git', 'worktrees', 'feature')));

    // The deprecated helpers answer from the same reading.
    expect(real(resolveWorktreeMainRepo(feature)!)).toBe(real(repo));
    expect(resolveWorktreeMainRepo(repo)).toBeNull();
    expect(discoverWorktreeSiblings(repo).map(real)).toEqual([real(feature)]);
  });

  it('lists a bare clone and its worktree', () => {
    const source = newRepo('source');
    git(root, 'clone', '-q', '--bare', source, path.join(root, 'bare.git'));
    const bareDir = path.join(root, 'bare.git');
    git(bareDir, 'worktree', 'add', '-q', '-b', 'work', path.join(root, 'bare-work'));

    const fromBare = resolveGitWorktrees(bareDir);
    expect(ours(fromBare)).toEqual(gitList(bareDir));
    expect(fromBare!.bare).toBe(true);
    expect(fromBare!.worktrees[0].kind).toBe('bare');

    const fromWorktree = resolveGitWorktrees(path.join(root, 'bare-work'));
    expect(ours(fromWorktree)).toEqual(gitList(path.join(root, 'bare-work')));
  });

  it('follows a .git file that points at a bare repository beside it', () => {
    const source = newRepo('source');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    git(project, 'clone', '-q', '--bare', source, '.bare');
    fs.writeFileSync(path.join(project, '.git'), 'gitdir: ./.bare\n');
    git(project, 'worktree', 'add', '-q', '-b', 'topic', path.join(project, 'topic'));

    const layout = resolveGitWorktrees(project);
    expect(ours(layout)).toEqual(gitList(project));
    expect(layout!.bare).toBe(true);
    expect(real(layout!.commonDir)).toBe(real(path.join(project, '.bare')));
    expect(ours(resolveGitWorktrees(path.join(project, 'topic')))).toEqual(
      gitList(path.join(project, 'topic')),
    );
  });

  it('finds the main checkout of a --separate-git-dir repository from that checkout', () => {
    const checkout = path.join(root, 'checkout');
    const separate = path.join(root, 'separate.git');
    git(root, 'init', '-q', `--separate-git-dir=${separate}`, checkout);
    commit(checkout);
    const linked = path.join(root, 'sep-linked');
    git(checkout, 'worktree', 'add', '-q', '-b', 'side', linked);

    // git names the separate git directory as the main worktree; the
    // checkout is where sessions run, so that is what is reported instead.
    const asGitWouldWithCheckout = (cwd: string) =>
      gitList(cwd)
        .map((dir) => (dir === real(separate) ? real(checkout) : dir))
        .sort();
    const fromCheckout = resolveGitWorktrees(checkout);
    expect(ours(fromCheckout)).toEqual(asGitWouldWithCheckout(checkout));
    expect(ours(fromCheckout)).toEqual([real(checkout), real(linked)].sort());
    expect(real(fromCheckout!.commonDir)).toBe(real(separate));

    // From the linked worktree nothing records where the checkout is, so
    // the main entry is missing; the git directory is not a checkout.
    const fromLinked = resolveGitWorktrees(linked);
    expect(ours(fromLinked)).toEqual([real(linked)]);
    expect(gitList(linked)).toEqual([real(linked), real(separate)].sort());
  });

  it('reads worktrees recorded with relative paths', () => {
    const repo = newRepo('rel-repo');
    const relative = path.join(root, 'rel-linked');
    const added = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'worktree',
        'add',
        '-q',
        '--relative-paths',
        '-b',
        'rel',
        relative,
      ],
      { cwd: repo, env: gitEnv, encoding: 'utf8' },
    );
    if (added.status !== 0) return; // git older than 2.48
    const recorded = fs.readFileSync(
      path.join(repo, '.git', 'worktrees', 'rel-linked', 'gitdir'),
      'utf8',
    );
    expect(path.isAbsolute(recorded.trim())).toBe(false);
    expect(ours(resolveGitWorktrees(repo))).toEqual(gitList(repo));
    expect(ours(resolveGitWorktrees(relative))).toEqual(gitList(relative));
  });

  it('leaves out a worktree whose directory was deleted', () => {
    const repo = newRepo('prune-repo');
    const gone = path.join(root, 'gone');
    git(repo, 'worktree', 'add', '-q', '-b', 'gone', gone);
    fs.rmSync(gone, { recursive: true, force: true });

    expect(ours(resolveGitWorktrees(repo))).toEqual([real(repo)]);
    expect(gitList(repo)).toEqual([real(repo)]);
  });

  it('keeps a submodule to itself, never its superproject', () => {
    const library = newRepo('library');
    const app = newRepo('app');
    git(app, 'submodule', 'add', '-q', library, 'lib');
    const lib = path.join(app, 'lib');

    // git lists the submodule's git directory as its main worktree; the
    // checkout is reported instead, and the superproject never is.
    expect(gitList(lib)).toEqual([real(path.join(app, '.git', 'modules', 'lib'))]);
    const layout = resolveGitWorktrees(lib);
    expect(ours(layout)).toEqual([real(lib)]);
    expect(real(layout!.commonDir)).toBe(real(path.join(app, '.git', 'modules', 'lib')));
    expect(ours(resolveGitWorktrees(app))).toEqual(gitList(app));
    expect(resolveWorktreeMainRepo(lib)).toBeNull();
  });

  it('returns null outside a repository layout', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(resolveGitWorktrees(plain)).toBeNull();
    expect(resolveGitWorktrees(path.join(root, 'missing'))).toBeNull();
    expect(resolveGitWorktrees('')).toBeNull();
  });
});

describe('resolveGitWorktrees (hand-made layouts)', () => {
  beforeEach(() => {
    root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-git-handmade-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the worktrees/ grandparent when commondir is missing', () => {
    const main = path.join(root, 'main');
    const linked = path.join(root, 'linked');
    const entry = path.join(main, '.git', 'worktrees', 'linked');
    fs.mkdirSync(entry, { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${entry}\n`);
    fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(linked, '.git')}\n`);

    const layout = resolveGitWorktrees(linked);
    expect(layout?.worktrees).toEqual([
      { path: main, kind: 'main', gitDir: path.join(main, '.git') },
      { path: linked, kind: 'linked', gitDir: entry },
    ]);
  });

  it('reads only the first 4 KiB of a config and honors [core] bare', () => {
    const bare = path.join(root, 'bare.git');
    fs.mkdirSync(path.join(bare, 'objects'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(bare, 'config'),
      '[remote "origin"]\n\tbare = false\n[core]\n\trepositoryformatversion = 0\n\tbare = true\n',
    );
    expect(resolveGitWorktrees(bare)?.bare).toBe(true);
    fs.writeFileSync(
      path.join(bare, 'config'),
      `[core]\n${'# filler\n'.repeat(600)}\tbare = true\n`,
    );
    expect(resolveGitWorktrees(bare)?.bare).toBe(false);
  });
});
