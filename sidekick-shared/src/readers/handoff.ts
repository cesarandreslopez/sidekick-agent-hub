/**
 * Reader for session handoff documents.
 */

import * as fs from 'fs';
import { getProjectDataPath, type ProjectIdentity } from '../paths';

export async function readLatestHandoff(project: string | ProjectIdentity): Promise<string | null> {
  const candidates = typeof project === 'string' ? [project] : project.candidates;
  for (const slug of candidates) {
    const filePath = getProjectDataPath(slug, 'handoffs').replace('.json', '-latest.md');
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      if (content.trim()) return content.trim();
    } catch {
      // Try the legacy candidate.
    }
  }
  return null;
}
