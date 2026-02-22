import { describe, it, expect } from 'vitest';
import { buildHandoffMarkdown } from './handoffFormat';
import type { HandoffInput } from './handoffFormat';

function makeInput(overrides?: Partial<HandoffInput>): HandoffInput {
  return {
    projectPath: '/home/user/my-project',
    date: '2026-02-18T12:00:00.000Z',
    duration: 3600000, // 1 hour
    pendingTasks: [],
    filesInProgress: [],
    recoveryPatterns: [],
    failedCommands: [],
    ...overrides,
  };
}

describe('buildHandoffMarkdown', () => {
  it('includes project name and date in header', () => {
    const md = buildHandoffMarkdown(makeInput());
    expect(md).toContain('# Session Handoff: my-project');
    expect(md).toContain('2026-02-18');
    expect(md).toContain('1h 0m');
  });

  it('includes pending tasks section when tasks exist', () => {
    const md = buildHandoffMarkdown(makeInput({
      pendingTasks: [
        { name: 'Fix bug', description: 'In the auth module' },
        { name: 'Write tests' },
      ],
    }));
    expect(md).toContain('## Pending Tasks');
    expect(md).toContain('**Fix bug** — In the auth module');
    expect(md).toContain('- Write tests');
  });

  it('omits pending tasks section when empty', () => {
    const md = buildHandoffMarkdown(makeInput({ pendingTasks: [] }));
    expect(md).not.toContain('## Pending Tasks');
  });

  it('includes files in progress section', () => {
    const md = buildHandoffMarkdown(makeInput({
      filesInProgress: ['src/main.ts', 'src/utils.ts'],
    }));
    expect(md).toContain('## Files In Progress');
    expect(md).toContain('- src/main.ts');
  });

  it('omits files section when empty', () => {
    const md = buildHandoffMarkdown(makeInput({ filesInProgress: [] }));
    expect(md).not.toContain('## Files In Progress');
  });

  it('includes recovery patterns', () => {
    const md = buildHandoffMarkdown(makeInput({
      recoveryPatterns: [{
        type: 'command_fallback',
        description: 'pnpm works instead of npm',
        failedApproach: 'npm install',
        successfulApproach: 'pnpm install',
        occurrences: 2,
      }],
    }));
    expect(md).toContain('## What Worked');
    expect(md).toContain('"npm install" failed');
    expect(md).toContain('"pnpm install" instead');
  });

  it('includes failed commands in avoid section', () => {
    const md = buildHandoffMarkdown(makeInput({
      failedCommands: ['rm -rf /', 'sudo make install'],
    }));
    expect(md).toContain('## Avoid');
    expect(md).toContain('- rm -rf /');
  });

  it('omits all optional sections when data is empty', () => {
    const md = buildHandoffMarkdown(makeInput());
    expect(md).not.toContain('## Pending Tasks');
    expect(md).not.toContain('## Files In Progress');
    expect(md).not.toContain('## What Worked');
    expect(md).not.toContain('## Avoid');
    // Should still have the header
    expect(md).toContain('# Session Handoff');
  });

  it('formats short durations correctly', () => {
    const md = buildHandoffMarkdown(makeInput({ duration: 45000 }));
    expect(md).toContain('45s');
  });

  it('includes context health warning when health is low', () => {
    const md = buildHandoffMarkdown(makeInput({
      contextHealth: 35,
      compactionCount: 4,
    }));
    expect(md).toContain('## Context Health Warning');
    expect(md).toContain('35% fidelity');
    expect(md).toContain('4 compactions');
  });

  it('omits context health warning when health is adequate', () => {
    const md = buildHandoffMarkdown(makeInput({
      contextHealth: 80,
      compactionCount: 1,
    }));
    expect(md).not.toContain('## Context Health Warning');
  });

  it('includes truncation summary', () => {
    const md = buildHandoffMarkdown(makeInput({
      truncationCount: 5,
      truncationsByTool: [
        { tool: 'Read', count: 3 },
        { tool: 'Bash', count: 2 },
      ],
    }));
    expect(md).toContain('## Truncated Outputs');
    expect(md).toContain('5 truncated tool outputs');
    expect(md).toContain('**Read**: 3');
    expect(md).toContain('**Bash**: 2');
  });

  it('omits truncation section when count is zero', () => {
    const md = buildHandoffMarkdown(makeInput({ truncationCount: 0 }));
    expect(md).not.toContain('## Truncated Outputs');
  });

  it('includes incomplete goal gates', () => {
    const md = buildHandoffMarkdown(makeInput({
      goalGates: ['Fix auth system', 'Deploy to prod'],
    }));
    expect(md).toContain('## CRITICAL: Incomplete Goal Gates');
    expect(md).toContain('**Fix auth system** was NOT completed');
    expect(md).toContain('**Deploy to prod** was NOT completed');
  });

  it('omits goal gates section when empty', () => {
    const md = buildHandoffMarkdown(makeInput());
    expect(md).not.toContain('Goal Gates');
  });
});
