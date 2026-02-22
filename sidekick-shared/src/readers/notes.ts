/**
 * Reader for knowledge notes.
 */

import type { KnowledgeNote, KnowledgeNoteStore, KnowledgeNoteType, KnowledgeNoteStatus } from '../types/knowledgeNote';
import { getProjectDataPath } from '../paths';
import { readJsonStore } from './helpers';

export interface ReadNotesOptions {
  file?: string;
  type?: KnowledgeNoteType;
  status?: KnowledgeNoteStatus;
}

export async function readNotes(slug: string, opts?: ReadNotesOptions): Promise<KnowledgeNote[]> {
  const filePath = getProjectDataPath(slug, 'knowledge-notes');
  const store = await readJsonStore<KnowledgeNoteStore>(filePath);
  if (!store) return [];

  let notes: KnowledgeNote[] = [];

  if (opts?.file) {
    // Normalize file path for comparison
    const normalizedFile = opts.file.replace(/\\/g, '/');
    for (const [filePath, fileNotes] of Object.entries(store.notesByFile)) {
      const normalizedKey = filePath.replace(/\\/g, '/');
      if (normalizedKey === normalizedFile || normalizedKey.endsWith('/' + normalizedFile) || normalizedFile.endsWith('/' + normalizedKey)) {
        notes.push(...fileNotes);
      }
    }
  } else {
    for (const fileNotes of Object.values(store.notesByFile)) {
      notes.push(...fileNotes);
    }
  }

  if (opts?.type) {
    notes = notes.filter(n => n.noteType === opts.type);
  }

  if (opts?.status) {
    notes = notes.filter(n => n.status === opts.status);
  }

  // Sort by importance then updatedAt
  const importanceOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  notes.sort((a, b) => {
    const ia = importanceOrder[a.importance] ?? 4;
    const ib = importanceOrder[b.importance] ?? 4;
    if (ia !== ib) return ia - ib;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return notes;
}
