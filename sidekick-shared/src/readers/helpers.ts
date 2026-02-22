/**
 * Shared reader helpers.
 */

import * as fs from 'fs';

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
