/**
 * Shared reader helpers.
 */

import * as fs from 'fs';
import { getProjectDataPath, type ProjectIdentity } from '../paths';

/**
 * Reads and parses a JSON store file. Returns null if file missing or malformed.
 */
export async function readJsonStore<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Reads the canonical project store, falling back to the legacy symlink slug. */
export async function readProjectJsonStore<T>(
  project: string | ProjectIdentity,
  subdomain: string,
): Promise<T | null> {
  const candidates = typeof project === 'string' ? [project] : project.candidates;
  for (const slug of candidates) {
    const store = await readJsonStore<T>(getProjectDataPath(slug, subdomain));
    if (store) return store;
  }
  return null;
}
