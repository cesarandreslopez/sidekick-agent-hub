import { describe, it, expect } from 'vitest';
import { resolveInstructionTarget } from './instructionFile';

describe('resolveInstructionTarget', () => {
  it('returns CLAUDE.md as primary for claude-code', () => {
    const target = resolveInstructionTarget('claude-code');
    expect(target.primaryFile).toBe('CLAUDE.md');
    expect(target.secondaryFile).toBe('AGENTS.md');
    expect(target.displayName).toBe('CLAUDE.md');
  });

  it('returns AGENTS.md as primary for opencode', () => {
    const target = resolveInstructionTarget('opencode');
    expect(target.primaryFile).toBe('AGENTS.md');
    expect(target.secondaryFile).toBe('CLAUDE.md');
    expect(target.displayName).toBe('AGENTS.md');
  });

  it('returns AGENTS.md as primary for codex', () => {
    const target = resolveInstructionTarget('codex');
    expect(target.primaryFile).toBe('AGENTS.md');
    expect(target.secondaryFile).toBe('CLAUDE.md');
    expect(target.displayName).toBe('AGENTS.md');
  });

  it('includes tip and notFoundMessage for each provider', () => {
    for (const providerId of ['claude-code', 'opencode', 'codex'] as const) {
      const target = resolveInstructionTarget(providerId);
      expect(target.tip).toBeTruthy();
      expect(target.notFoundMessage).toBeTruthy();
      expect(target.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('claude-code tip mentions /init', () => {
    const target = resolveInstructionTarget('claude-code');
    expect(target.tip).toContain('/init');
  });

  it('opencode tip mentions AGENTS.md', () => {
    const target = resolveInstructionTarget('opencode');
    expect(target.tip).toContain('AGENTS.md');
  });

  it('notFoundMessage includes a runnable command', () => {
    for (const providerId of ['claude-code', 'opencode', 'codex'] as const) {
      const target = resolveInstructionTarget(providerId);
      // Each message should tell the user exactly what to run
      expect(target.notFoundMessage).toMatch(/run[: ]/i);
    }
  });
});
