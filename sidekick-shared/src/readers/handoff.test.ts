import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ directory: '' }));

vi.mock('../paths', () => ({
  getProjectDataPath: (slug: string) => path.join(mocks.directory, `${slug}.json`),
}));

import { readLatestHandoff } from './handoff';

afterEach(async () => {
  if (mocks.directory) {
    await fs.promises.rm(mocks.directory, { recursive: true, force: true });
    mocks.directory = '';
  }
});

describe('readLatestHandoff', () => {
  it('replaces only the final JSON extension for dotted project slugs', async () => {
    mocks.directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-handoff-'));
    await fs.promises.writeFile(
      path.join(mocks.directory, 'client.json-tools-latest.md'),
      'Latest handoff\n',
    );

    await expect(readLatestHandoff('client.json-tools')).resolves.toBe('Latest handoff');
  });
});
