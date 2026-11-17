import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import type { ContextResult, DecisionEntry, KnowledgeNote, PersistedTask } from 'sidekick-shared';

vi.mock('../cli', () => ({ resolveProvider: vi.fn() }));

import { formatContextText } from './context';
import { printDecisionsList } from './decisions';
import { printNotesList } from './notes';

const PLACEHOLDER = '[nested value omitted]';

function decision(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    id: 'd1',
    description: 'Which store?',
    rationale: '',
    alternatives: [PLACEHOLDER, 'JSON file', PLACEHOLDER],
    chosenOption: 'SQLite',
    source: 'user_question',
    sessionId: 'abc',
    timestamp: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

function note(overrides: Partial<KnowledgeNote> = {}): KnowledgeNote {
  return {
    id: 'n1',
    filePath: '.',
    noteType: 'tip',
    content: 'Remember the thing',
    status: 'needs_review',
    importance: 'medium',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    lastReviewedAt: '2026-11-01T10:00:00.000Z',
    source: 'manual',
    ...overrides,
  } as KnowledgeNote;
}

let out: string[];
beforeEach(() => {
  out = [];
  chalk.level = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('project renderers', () => {
  it('decisions drop omitted-value placeholders and name CLI decisions as such', () => {
    printDecisionsList([
      decision(),
      decision({ id: 'd2', sessionId: 'cli', source: 'text_pattern' }),
    ]);
    const text = out.join('');
    expect(text).not.toContain(PLACEHOLDER);
    expect(text).toContain('Alternatives: JSON file');
    expect(text).toContain('· cli');
  });

  it('prints an unknown status as written, even one named like an Object member', () => {
    printNotesList([note({ status: 'constructor' as never, noteType: 'toString' as never })]);
    const text = out.join('');
    expect(text).toContain('constructor');
    expect(text).not.toContain('function');
  });

  it('notes read their status and say project-wide for a note with no file', () => {
    printNotesList([note()]);
    const text = out.join('');
    expect(text).toContain('Needs review');
    expect(text).not.toContain('needs_review');
    expect(text).toContain('project-wide');
    expect(text).not.toMatch(/· \.\s/);
  });

  it('context reads statuses, filters placeholders, and labels its usage as all projects', () => {
    const ctx: ContextResult = {
      provider: 'claude-code',
      tasks: {
        items: [{ taskId: '1', subject: 'Ship it', status: 'in_progress' } as PersistedTask],
        total: 1,
      },
      decisions: { items: [decision()], total: 1 },
      notes: { items: [note()], total: 1 },
      handoff: null,
      stats: {
        tokens: { inputTokens: 1494051, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        cost: 12.5,
      },
      sessionSummaries: [],
    } as unknown as ContextResult;
    const text = formatContextText(ctx, 'slug');
    expect(text).toContain('- [In Progress] Ship it');
    expect(text).not.toContain('IN_PROGRESS');
    expect(text).not.toContain(PLACEHOLDER);
    expect(text).toContain('## Usage (all projects, all time)');
    expect(text).toContain('Tokens: 1,494,051 in');
    expect(text).toContain('[tip/medium/Needs review]');
  });
});
