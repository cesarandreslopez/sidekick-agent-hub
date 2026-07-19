import * as crypto from 'crypto';
import { getProjectDataPath, resolveProjectIdentity } from '../paths';
import { migrateLegacyProjectStores } from '../projectMigration';
import {
  KNOWLEDGE_NOTE_SCHEMA_VERSION,
  type KnowledgeNote,
  type KnowledgeNoteImportance,
  type KnowledgeNoteStore,
  type KnowledgeNoteType,
} from '../types/knowledgeNote';
import { updateJsonStoreAtomic } from './atomic';

function emptyNoteStore(): KnowledgeNoteStore {
  return {
    schemaVersion: KNOWLEDGE_NOTE_SCHEMA_VERSION,
    notesByFile: {},
    lastSaved: new Date().toISOString(),
    totalNotes: 0,
  };
}

export async function addNote(
  cwd: string,
  content: string,
  options: {
    filePath?: string;
    title?: string;
    noteType?: KnowledgeNoteType;
    importance?: KnowledgeNoteImportance;
    tags?: string[];
  } = {},
): Promise<KnowledgeNote> {
  const project = resolveProjectIdentity(cwd);
  migrateLegacyProjectStores(project);
  const filePath = getProjectDataPath(project.canonicalSlug, 'knowledge-notes');
  const now = new Date().toISOString();
  const notePath = options.filePath?.trim() || '.';
  const note: KnowledgeNote = {
    id: crypto.randomUUID(),
    noteType: options.noteType ?? 'tip',
    content: content.trim(),
    title: options.title,
    filePath: notePath,
    source: 'manual',
    status: 'active',
    importance: options.importance ?? 'medium',
    createdAt: now,
    updatedAt: now,
    lastReviewedAt: now,
    tags: options.tags,
  };
  await updateJsonStoreAtomic(filePath, emptyNoteStore, (store) => {
    const existing = store.notesByFile[notePath] ?? [];
    const notesByFile = { ...store.notesByFile, [notePath]: [...existing, note] };
    return {
      ...store,
      schemaVersion: KNOWLEDGE_NOTE_SCHEMA_VERSION,
      notesByFile,
      totalNotes: Object.values(notesByFile).reduce((sum, notes) => sum + notes.length, 0),
      lastSaved: now,
    };
  });
  return note;
}
