import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateJsonStoreAtomic } from './atomic';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe('updateJsonStoreAtomic', () => {
  it('preserves every interleaved read-modify-write update', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidekick-writer-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'tasks.json');

    await Promise.all(
      Array.from({ length: 24 }, (_, id) =>
        updateJsonStoreAtomic(
          filePath,
          () => ({ schemaVersion: 1, entries: {} as Record<string, number>, lastSaved: '' }),
          async (store) => {
            await new Promise((resolve) => setTimeout(resolve, id % 3));
            return {
              ...store,
              entries: { ...store.entries, [String(id)]: id },
              lastSaved: new Date().toISOString(),
            };
          },
        ),
      ),
    );

    const persisted = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      entries: Record<string, number>;
      lastSaved: string;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(Object.keys(persisted.entries)).toHaveLength(24);
    expect(persisted.entries['0']).toBe(0);
    expect(persisted.entries['23']).toBe(23);
    expect(persisted.lastSaved).not.toBe('');
    await expect(fs.promises.access(`${filePath}.lock`)).rejects.toThrow();
  });
});
