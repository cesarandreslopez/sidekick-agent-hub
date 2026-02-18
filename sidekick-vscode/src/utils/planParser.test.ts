import { describe, it, expect } from 'vitest';
import { parsePlanMarkdown, extractProposedPlan } from './planParser';

describe('planParser', () => {
  describe('parsePlanMarkdown', () => {
    it('should return empty steps for empty input', () => {
      expect(parsePlanMarkdown('')).toEqual({ steps: [] });
      expect(parsePlanMarkdown('   ')).toEqual({ steps: [] });
    });

    it('should parse checkbox list with pending and completed items', () => {
      const md = `# Implementation Plan

- [ ] Set up project structure
- [x] Install dependencies
- [ ] Write tests
- [X] Configure linting`;

      const result = parsePlanMarkdown(md);
      expect(result.title).toBe('Implementation Plan');
      expect(result.steps).toHaveLength(4);
      expect(result.steps[0]).toEqual({
        id: 'step-0',
        description: 'Set up project structure',
        status: 'pending',
        phase: undefined,
      });
      expect(result.steps[1]).toEqual({
        id: 'step-1',
        description: 'Install dependencies',
        status: 'completed',
        phase: undefined,
      });
      expect(result.steps[2].status).toBe('pending');
      expect(result.steps[3].status).toBe('completed');
    });

    it('should parse numbered list items', () => {
      const md = `## Plan

1. Read the existing code
2. Identify the bug
3. Write a fix`;

      const result = parsePlanMarkdown(md);
      expect(result.title).toBe('Plan');
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0]).toEqual({
        id: 'step-0',
        description: 'Read the existing code',
        status: 'pending',
        phase: undefined,
      });
      expect(result.steps[2].description).toBe('Write a fix');
    });

    it('should parse numbered list with parentheses', () => {
      const md = `1) First step
2) Second step`;

      const result = parsePlanMarkdown(md);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].description).toBe('First step');
    });

    it('should assign phase from phase headers', () => {
      const md = `# Refactor Plan

## Phase 1: Analysis
- [ ] Read all files
- [ ] Map dependencies

## Phase 2: Implementation
- [ ] Refactor module A
- [x] Refactor module B`;

      const result = parsePlanMarkdown(md);
      expect(result.title).toBe('Refactor Plan');
      expect(result.steps).toHaveLength(4);
      expect(result.steps[0].phase).toBe('Analysis');
      expect(result.steps[1].phase).toBe('Analysis');
      expect(result.steps[2].phase).toBe('Implementation');
      expect(result.steps[3].phase).toBe('Implementation');
    });

    it('should handle Step headers as phases', () => {
      const md = `### Step 1: Setup
- [ ] Create files

### Step 2: Build
- [ ] Compile`;

      const result = parsePlanMarkdown(md);
      expect(result.steps[0].phase).toBe('Setup');
      expect(result.steps[1].phase).toBe('Build');
    });

    it('should handle mixed checkbox and numbered lists', () => {
      const md = `# Plan

- [ ] First checkbox item
1. First numbered item
- [x] Second checkbox item`;

      const result = parsePlanMarkdown(md);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].status).toBe('pending');
      expect(result.steps[1].status).toBe('pending');
      expect(result.steps[2].status).toBe('completed');
    });

    it('should extract title from H1 header', () => {
      const md = `# My Big Plan

- [ ] Do thing`;

      const result = parsePlanMarkdown(md);
      expect(result.title).toBe('My Big Plan');
    });

    it('should extract title from H2 header if no H1', () => {
      const md = `## Secondary Plan

- [ ] Do thing`;

      const result = parsePlanMarkdown(md);
      expect(result.title).toBe('Secondary Plan');
    });

    it('should handle asterisk bullet points', () => {
      const md = `* [ ] Step one
* [x] Step two`;

      const result = parsePlanMarkdown(md);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].description).toBe('Step one');
      expect(result.steps[1].status).toBe('completed');
    });

    it('should ignore non-list non-header lines', () => {
      const md = `# Plan

Some introductory text that is not a step.

- [ ] Actual step

More text between steps.

- [ ] Another step`;

      const result = parsePlanMarkdown(md);
      expect(result.steps).toHaveLength(2);
    });

    it('should assign sequential step IDs', () => {
      const md = `- [ ] A
- [ ] B
- [ ] C`;

      const result = parsePlanMarkdown(md);
      expect(result.steps.map(s => s.id)).toEqual(['step-0', 'step-1', 'step-2']);
    });
  });

  describe('extractProposedPlan', () => {
    it('should extract content from proposed_plan tags', () => {
      const text = `Here is my plan:

<proposed_plan>
# Plan
- [ ] Step one
- [ ] Step two
</proposed_plan>

I'll proceed with this.`;

      const result = extractProposedPlan(text);
      expect(result).toBe('# Plan\n- [ ] Step one\n- [ ] Step two');
    });

    it('should return null when no proposed_plan tags', () => {
      expect(extractProposedPlan('Just some text without a plan.')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(extractProposedPlan('')).toBeNull();
    });

    it('should handle proposed_plan with only whitespace', () => {
      const result = extractProposedPlan('<proposed_plan>   </proposed_plan>');
      expect(result).toBe('');
    });
  });
});
