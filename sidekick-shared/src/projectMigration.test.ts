import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { migrateLegacyProjectStores } from './projectMigration';
import { encodeWorkspacePath, getProjectDataPath } from './paths';

let tmpDir: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

describe('migrateLegacyProjectStores', () => {
  let realProjectDir: string;
  let linkedProjectDir: string;

  beforeEach(() => {
    // Base on the realpath of tmpdir so only our own symlink causes a
    // legacy/canonical mismatch (macOS tmpdir is itself a symlink).
    tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sidekick-migration-test-'));
    realProjectDir = path.join(tmpDir, 'real-project');
    linkedProjectDir = path.join(tmpDir, 'linked-project');
    fs.mkdirSync(realProjectDir, { recursive: true });
    fs.symlinkSync(realProjectDir, linkedProjectDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies legacy raw-slug stores to the canonical slug once', () => {
    const legacySlug = encodeWorkspacePath(linkedProjectDir);
    const canonicalSlug = encodeWorkspacePath(realProjectDir);
    const legacyTasksPath = getProjectDataPath(legacySlug, 'tasks');
    fs.mkdirSync(path.dirname(legacyTasksPath), { recursive: true });
    const store = { schemaVersion: 3, tasks: { a: { taskId: 'a' } }, lastSaved: 'x' };
    fs.writeFileSync(legacyTasksPath, JSON.stringify(store));

    const migrated = migrateLegacyProjectStores(linkedProjectDir);

    const canonicalTasksPath = getProjectDataPath(canonicalSlug, 'tasks');
    expect(migrated).toContain(canonicalTasksPath);
    expect(JSON.parse(fs.readFileSync(canonicalTasksPath, 'utf8'))).toEqual(store);
    expect(fs.existsSync(legacyTasksPath)).toBe(true);
    // Second run is a no-op: canonical files already exist.
    expect(migrateLegacyProjectStores(linkedProjectDir)).toEqual([]);
  });

  it('never overwrites an existing canonical store', () => {
    const legacySlug = encodeWorkspacePath(linkedProjectDir);
    const canonicalSlug = encodeWorkspacePath(realProjectDir);
    const legacyPath = getProjectDataPath(legacySlug, 'decisions');
    const canonicalPath = getProjectDataPath(canonicalSlug, 'decisions');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ from: 'legacy' }));
    fs.writeFileSync(canonicalPath, JSON.stringify({ from: 'canonical' }));

    migrateLegacyProjectStores(linkedProjectDir);

    expect(JSON.parse(fs.readFileSync(canonicalPath, 'utf8'))).toEqual({ from: 'canonical' });
  });

  it('does nothing for projects without a slug mismatch', () => {
    expect(migrateLegacyProjectStores(realProjectDir)).toEqual([]);
  });
});
