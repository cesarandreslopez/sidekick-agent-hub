import { describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';

const writers = vi.hoisted(() => ({
  addTask: vi.fn(),
  addNote: vi.fn(),
  addDecision: vi.fn(),
  completeTask: vi.fn(),
}));
vi.mock('sidekick-shared', () => writers);

import { decisionAddAction, noteAddAction, taskAddAction } from './capture';

const cmd = { opts: () => ({}), parent: undefined } as unknown as Command;

describe('capture commands', () => {
  it('refuse blank input instead of saving an empty entry', async () => {
    await expect(taskAddAction('   ', cmd)).rejects.toThrow('A task subject is required');
    await expect(noteAddAction('', cmd)).rejects.toThrow('Note content is required');
    await expect(decisionAddAction('\n', cmd)).rejects.toThrow('A decision is required');
    expect(writers.addTask).not.toHaveBeenCalled();
    expect(writers.addNote).not.toHaveBeenCalled();
    expect(writers.addDecision).not.toHaveBeenCalled();
  });
});
