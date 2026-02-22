/**
 * Reader for session handoff documents.
 */

import * as fs from 'fs';
import { getProjectDataPath } from '../paths';

export async function readLatestHandoff(slug: string): Promise<string | null> {
  const filePath = getProjectDataPath(slug, 'handoffs').replace('.json', '-latest.md');
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
