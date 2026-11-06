import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realpathOrNull, resolveWorkspaceRoots } from './workspaceRoots';

let root: string;

/** A main checkout with one linked worktree, laid out the way git writes them. */
function repoWithWorktree(): { main: string; linked: string } {
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const entry = path.join(main, '.git', 'worktrees', 'linked');
  fs.mkdirSync(path.join(main, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(linked, '.git')}\n`);
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${entry}\n`);
  return { main, linked };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-workspace-roots-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveWorkspaceRoots', () => {
  it('adds the main checkout and every linked worktree of a root', () => {
    const { main, linked } = repoWithWorktree();
    expect(resolveWorkspaceRoots([linked]).roots.sort()).toEqual([linked, main].sort());
    expect(resolveWorkspaceRoots([main]).roots.sort()).toEqual([linked, main].sort());
    expect(resolveWorkspaceRoots([linked], { includeWorktrees: false }).roots).toEqual([linked]);
  });

  it('never adds a bare repository directory as a root', () => {
    const bare = path.join(root, 'bare.git');
    const work = path.join(root, 'work');
    const entry = path.join(bare, 'worktrees', 'work');
    fs.mkdirSync(path.join(bare, 'objects'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(bare, 'config'), '[core]\n\tbare = true\n');
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(work, '.git')}\n`);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, '.git'), `gitdir: ${entry}\n`);
    expect(resolveWorkspaceRoots([work]).roots).toEqual([work]);
  });

  it('keeps unresolved spellings for listing and drops relative or missing roots', () => {
    const link = path.join(root, 'link');
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');
    const resolved = resolveWorkspaceRoots([link, 'relative', path.join(root, 'missing')]);
    expect(resolved.roots).toEqual([target]);
    expect(resolved.listingRoots.sort()).toEqual([link, target].sort());
  });

  it('caches realpaths in the map it is given', () => {
    const cache = new Map<string, string | null>();
    expect(realpathOrNull(root, cache)).toBe(root);
    expect(cache.get(root)).toBe(root);
    expect(realpathOrNull('relative', cache)).toBeNull();
  });
});
