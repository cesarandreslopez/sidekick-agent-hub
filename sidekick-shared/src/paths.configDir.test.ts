/**
 * Config-root resolution and the override seam.
 *
 * Kept out of `paths.test.ts` so that file can keep asserting the unmodified
 * platform default without env/override bookkeeping bleeding across suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CONFIG_DIR_ENV_VAR,
  getConfigDir,
  getConfigDirOverride,
  getDefaultConfigDir,
  getGlobalDataPath,
  getProjectDataPath,
  resolveProjectIdentity,
  setConfigDir,
} from './paths';
import { addTask } from './writers/tasks';
import { readTasks } from './readers/tasks';

describe('config directory resolution', () => {
  beforeEach(() => {
    setConfigDir(null);
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '');
  });

  afterEach(() => {
    setConfigDir(null);
    vi.unstubAllEnvs();
  });

  it('falls back to the platform default', () => {
    expect(getConfigDir()).toBe(getDefaultConfigDir());
    expect(getConfigDirOverride()).toBeNull();
  });

  it('honors SIDEKICK_CONFIG_DIR over the default', () => {
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '/tmp/sidekick-env-root');
    expect(getConfigDir()).toBe(path.resolve('/tmp/sidekick-env-root'));
  });

  it('lets setConfigDir win over the environment', () => {
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '/tmp/sidekick-env-root');
    setConfigDir('/tmp/sidekick-explicit-root');
    expect(getConfigDir()).toBe(path.resolve('/tmp/sidekick-explicit-root'));
    expect(getConfigDirOverride()).toBe(path.resolve('/tmp/sidekick-explicit-root'));
  });

  it.each([null, undefined, '', '   '])('treats %p as clearing the override', (value) => {
    setConfigDir('/tmp/sidekick-explicit-root');
    setConfigDir(value);
    expect(getConfigDirOverride()).toBeNull();
    expect(getConfigDir()).toBe(getDefaultConfigDir());
  });

  it('resolves relative input to an absolute path', () => {
    setConfigDir('./relative-config');
    expect(path.isAbsolute(getConfigDir())).toBe(true);
    expect(getConfigDir()).toBe(path.resolve('./relative-config'));
  });

  it('agrees with the environment variable on a padded path', () => {
    // A value forwarded from a config file or shell variable can carry
    // whitespace. Resolving it untrimmed makes the padding a relative segment,
    // so the root silently lands under cwd instead of where it was pointed.
    setConfigDir('  /tmp/sidekick-padded-root  ');
    expect(getConfigDir()).toBe(path.resolve('/tmp/sidekick-padded-root'));

    setConfigDir(null);
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '  /tmp/sidekick-padded-root  ');
    expect(getConfigDir()).toBe(path.resolve('/tmp/sidekick-padded-root'));
  });

  it('ignores a blank environment variable', () => {
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '   ');
    expect(getConfigDir()).toBe(getDefaultConfigDir());
  });

  it('getDefaultConfigDir ignores both override mechanisms', () => {
    const platformDefault = getDefaultConfigDir();
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '/tmp/sidekick-env-root');
    setConfigDir('/tmp/sidekick-explicit-root');
    expect(getDefaultConfigDir()).toBe(platformDefault);
  });

  it('redirects the derived path helpers', () => {
    setConfigDir('/tmp/sidekick-explicit-root');
    const root = path.resolve('/tmp/sidekick-explicit-root');
    expect(getProjectDataPath('my-slug', 'tasks')).toBe(path.join(root, 'tasks', 'my-slug.json'));
    expect(getGlobalDataPath('historical-data.json')).toBe(path.join(root, 'historical-data.json'));
  });
});

describe('config directory seam, end to end', () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    setConfigDir(null);
    vi.stubEnv(CONFIG_DIR_ENV_VAR, '');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-config-root-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-workspace-'));
  });

  afterEach(async () => {
    setConfigDir(null);
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('routes real writers and readers through the override, with no module mocking', async () => {
    // The seam is only worth anything if it covers callers that never touch
    // getConfigDir directly — addTask reaches it through getProjectDataPath.
    setConfigDir(root);

    const task = await addTask(workspace, 'isolated task');
    expect(task.subject).toBe('isolated task');

    const written = await fs.readdir(path.join(root, 'tasks'));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/\.json$/);

    // readTasks treats a bare string as a slug, so a cwd must go through
    // resolveProjectIdentity first — which also buys the legacy-slug fallback.
    const tasks = await readTasks(resolveProjectIdentity(workspace));
    expect(tasks.map((t) => t.subject)).toContain('isolated task');
  });

  it('works through SIDEKICK_CONFIG_DIR alone', async () => {
    vi.stubEnv(CONFIG_DIR_ENV_VAR, root);

    await addTask(workspace, 'env task');

    const written = await fs.readdir(path.join(root, 'tasks'));
    expect(written).toHaveLength(1);
  });
});
