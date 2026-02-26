import { describe, it, expect } from 'vitest';
import { parsePlanMarkdown, PlanExtractor } from './planExtractor';
import type { FollowEvent } from '../watchers/types';

function mkEvent(overrides: Partial<FollowEvent> & Pick<FollowEvent, 'type' | 'summary'>): FollowEvent {
  return {
    providerId: 'claude-code',
    timestamp: new Date().toISOString(),
    raw: {},
    ...overrides,
  } as FollowEvent;
}

describe('parsePlanMarkdown', () => {
  it('parses checkboxes correctly', () => {
    const md = `# My Plan
- [ ] First step
- [x] Second step
- [ ] Third step`;
    const result = parsePlanMarkdown(md);
    expect(result.title).toBe('My Plan');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].status).toBe('pending');
    expect(result.steps[0].description).toBe('First step');
    expect(result.steps[1].status).toBe('completed');
    expect(result.steps[2].status).toBe('pending');
  });

  it('parses numbered lists correctly', () => {
    const md = `# Migration Plan
1. Update dependencies
2. Refactor the module
3. Run tests`;
    const result = parsePlanMarkdown(md);
    expect(result.title).toBe('Migration Plan');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].description).toBe('Update dependencies');
    expect(result.steps[1].description).toBe('Refactor the module');
    expect(result.steps[1].complexity).toBe('high'); // "refactor" keyword
    expect(result.steps[2].description).toBe('Run tests');
  });

  it('parses simple bullet points as pending steps', () => {
    const md = `# Setup Plan
- Install dependencies
- Configure the environment
- Start the server`;
    const result = parsePlanMarkdown(md);
    expect(result.title).toBe('Setup Plan');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].description).toBe('Install dependencies');
    expect(result.steps[0].status).toBe('pending');
    expect(result.steps[1].description).toBe('Configure the environment');
    expect(result.steps[2].description).toBe('Start the server');
  });

  it('parses asterisk bullet points', () => {
    const md = `# Plan
* First task
* Second task`;
    const result = parsePlanMarkdown(md);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].description).toBe('First task');
  });

  it('normalizes bold-colon bullet patterns', () => {
    const md = `# Plan
- **Setup**: Install all dependencies
- **Build**: Compile the project
- **Test**: Run the test suite`;
    const result = parsePlanMarkdown(md);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].description).toBe('Setup: Install all dependencies');
    expect(result.steps[1].description).toBe('Build: Compile the project');
    expect(result.steps[2].description).toBe('Test: Run the test suite');
  });

  it('skips trivially short bullet lines', () => {
    const md = `# Plan
- OK
- Install dependencies
- Go`;
    const result = parsePlanMarkdown(md);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].description).toBe('Install dependencies');
  });

  it('does not treat checkboxes as bullets', () => {
    const md = `# Plan
- [ ] Unchecked step
- [x] Checked step
- Regular bullet step`;
    const result = parsePlanMarkdown(md);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].status).toBe('pending'); // checkbox
    expect(result.steps[1].status).toBe('completed'); // checkbox
    expect(result.steps[2].status).toBe('pending'); // bullet
    expect(result.steps[2].description).toBe('Regular bullet step');
  });

  it('groups steps under phase headers', () => {
    const md = `# Implementation Plan
## Phase 1: Setup
- Install packages
- Configure linting

## Phase 2: Build
- Create components
- Add styles`;
    const result = parsePlanMarkdown(md);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].phase).toBe('Setup');
    expect(result.steps[1].phase).toBe('Setup');
    expect(result.steps[2].phase).toBe('Build');
    expect(result.steps[3].phase).toBe('Build');
  });

  it('returns 0 steps for empty or blank markdown', () => {
    expect(parsePlanMarkdown('').steps).toHaveLength(0);
    expect(parsePlanMarkdown('   \n  \n  ').steps).toHaveLength(0);
  });

  it('returns 0 steps for markdown with only headers', () => {
    const md = `# Plan Title
## Section Header`;
    const result = parsePlanMarkdown(md);
    expect(result.title).toBe('Plan Title');
    expect(result.steps).toHaveLength(0);
  });
});

describe('PlanExtractor', () => {
  it('stores plans with rawMarkdown even when 0 parsed steps', () => {
    const extractor = new PlanExtractor();
    const markdown = '# My Plan\n\nThis is a narrative plan with no structured steps.';

    extractor.processEvent(mkEvent({
      type: 'tool_use',
      toolName: 'EnterPlanMode',
      summary: 'Entering plan mode',
    }));

    extractor.processEvent(mkEvent({
      type: 'assistant',
      summary: markdown,
      raw: { message: { content: [{ type: 'text', text: markdown }] } },
    }));

    extractor.processEvent(mkEvent({
      type: 'tool_use',
      toolName: 'ExitPlanMode',
      summary: 'Exiting plan mode',
    }));

    expect(extractor.plan).not.toBeNull();
    expect(extractor.plan!.rawMarkdown).toBe(markdown);
    expect(extractor.plan!.source).toBe('claude-code');
    expect(extractor.plan!.title).toBe('My Plan');
  });

  it('stores plans with parsed bullet steps', () => {
    const extractor = new PlanExtractor();
    const markdown = `# Refactoring Plan
- Identify dead code
- Remove unused imports
- Update tests`;

    extractor.processEvent(mkEvent({
      type: 'tool_use',
      toolName: 'EnterPlanMode',
      summary: '',
    }));

    extractor.processEvent(mkEvent({
      type: 'assistant',
      summary: markdown,
      raw: { message: { content: [{ type: 'text', text: markdown }] } },
    }));

    extractor.processEvent(mkEvent({
      type: 'tool_use',
      toolName: 'ExitPlanMode',
      summary: '',
    }));

    expect(extractor.plan).not.toBeNull();
    expect(extractor.plan!.steps).toHaveLength(3);
    expect(extractor.plan!.steps[0].description).toBe('Identify dead code');
    expect(extractor.plan!.rawMarkdown).toBe(markdown);
  });
});
