import { describe, it, expect } from 'vitest';
import { buildGuidanceAnalysisPrompt, parseGuidanceSuggestions } from './analysisPrompts';
import type { SessionAnalysisData } from '../types/analysis';
import type { InstructionFileTarget } from '../types/instructionFile';

function makeSessionData(overrides?: Partial<SessionAnalysisData>): SessionAnalysisData {
  return {
    errors: [],
    toolPatterns: [],
    inefficiencies: [],
    recoveryPatterns: [],
    recentActivity: ['Did something'],
    sessionDuration: 600000,
    totalTokens: 10000,
    projectPath: '/home/user/project',
    hasEnoughData: true,
    currentClaudeMd: '# Existing CLAUDE.md',
    currentAgentsMd: undefined,
    ...overrides,
  };
}

function makeTarget(overrides?: Partial<InstructionFileTarget>): InstructionFileTarget {
  return {
    primaryFile: 'CLAUDE.md',
    secondaryFile: 'AGENTS.md',
    displayName: 'CLAUDE.md',
    tip: 'Test tip',
    notFoundMessage: 'Not found',
    docsUrl: 'https://example.com',
    ...overrides,
  };
}

describe('buildGuidanceAnalysisPrompt', () => {
  it('uses primary file name in prompt for CLAUDE.md target', () => {
    const prompt = buildGuidanceAnalysisPrompt(makeSessionData(), makeTarget());
    expect(prompt).toContain('Append this to CLAUDE.md');
    expect(prompt).toContain('<filename>CLAUDE.md</filename>');
  });

  it('uses primary file name in prompt for AGENTS.md target', () => {
    const target = makeTarget({ primaryFile: 'AGENTS.md', secondaryFile: 'CLAUDE.md' });
    const data = makeSessionData({ currentAgentsMd: '# AGENTS.md content', currentClaudeMd: '# CLAUDE.md content' });
    const prompt = buildGuidanceAnalysisPrompt(data, target);
    expect(prompt).toContain('Append this to AGENTS.md');
    expect(prompt).toContain('<filename>AGENTS.md</filename>');
  });

  it('includes secondary file section when content exists', () => {
    const data = makeSessionData({ currentAgentsMd: '# AGENTS.md content' });
    const prompt = buildGuidanceAnalysisPrompt(data, makeTarget());
    expect(prompt).toContain('<secondary_file>');
    expect(prompt).toContain('<filename>AGENTS.md</filename>');
  });

  it('omits secondary file section when no content', () => {
    const data = makeSessionData({ currentAgentsMd: undefined });
    const prompt = buildGuidanceAnalysisPrompt(data, makeTarget());
    expect(prompt).not.toContain('<secondary_file>');
  });
});

describe('parseGuidanceSuggestions', () => {
  it('parses consolidated format with CLAUDE.md', () => {
    const response = `### Recommended Addition
**Summary:** Add project conventions

**Append this to CLAUDE.md:**
\`\`\`
## Build
Use pnpm, not npm.
\`\`\`

**Rationale:**
- Recovery patterns show pnpm works
- npm failed 3 times`;

    const suggestions = parseGuidanceSuggestions(response);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].title).toBe('Recommended Addition');
    expect(suggestions[0].suggestion).toContain('Use pnpm');
    expect(suggestions[0].reasoning).toContain('pnpm works');
  });

  it('parses consolidated format with AGENTS.md', () => {
    const response = `### Recommended Addition
**Summary:** Add agent conventions

**Append this to AGENTS.md:**
\`\`\`
## Testing
Always run vitest.
\`\`\`

**Rationale:**
- Tests were missed in session`;

    const suggestions = parseGuidanceSuggestions(response);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestion).toContain('Always run vitest');
  });

  it('returns empty array for unparseable response', () => {
    const suggestions = parseGuidanceSuggestions('Just some random text with no structure.');
    expect(suggestions).toHaveLength(0);
  });

  it('handles old multi-suggestion format', () => {
    const response = `### Suggestion 1: Use pnpm
**Observed:** npm failed repeatedly
**Add to CLAUDE.md:**
\`\`\`
Use pnpm install
\`\`\`
**Why:** npm is broken`;

    const suggestions = parseGuidanceSuggestions(response);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].title).toBe('Use pnpm');
  });
});
