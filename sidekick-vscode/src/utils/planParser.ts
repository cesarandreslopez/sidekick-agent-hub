/**
 * @fileoverview Parser for extracting structured plan steps from markdown.
 *
 * Handles plan content from all three providers:
 * - Claude Code: Markdown written to `.claude/plans/` or assistant text during plan mode
 * - OpenCode: `<proposed_plan>` markdown blocks in assistant messages
 * - Codex: `UpdatePlan` tool calls provide structured arrays (no parsing needed)
 *
 * @module utils/planParser
 */

import type { PlanStep } from '../types/claudeSession';

/** Checkbox pattern: `- [ ] text` or `- [x] text` */
const CHECKBOX_PATTERN = /^[-*]\s+\[([ xX])\]\s+(.+)/;

/** Numbered list pattern: `1. text` or `1) text` */
const NUMBERED_PATTERN = /^\d+[.)]\s+(.+)/;

/** Phase header pattern: `## Phase 1: Setup` or `### Step 1: Do thing` */
const PHASE_HEADER_PATTERN = /^#{2,4}\s+(?:Phase|Step|Stage)\s*\d*[:.]\s*(.+)/i;

/** Generic H1/H2 header for title extraction */
const TITLE_HEADER_PATTERN = /^#{1,2}\s+(.+)/;

/**
 * Parses plan markdown into structured plan steps.
 *
 * Parsing priority:
 * 1. Checkbox lists: `- [ ] Step text` → pending, `- [x] Step text` → completed
 * 2. Numbered lists: `1. Step text` → pending
 * 3. Phase headers: Used as `phase` field on subsequent steps
 *
 * @param markdown - Raw markdown content from plan mode
 * @returns Extracted title and plan steps
 */
export function parsePlanMarkdown(markdown: string): { title?: string; steps: PlanStep[] } {
  if (!markdown || !markdown.trim()) {
    return { steps: [] };
  }

  const lines = markdown.split('\n');
  const steps: PlanStep[] = [];
  let title: string | undefined;
  let currentPhase: string | undefined;
  let stepIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check for title (first H1/H2 header)
    if (!title) {
      const titleMatch = line.match(TITLE_HEADER_PATTERN);
      if (titleMatch) {
        title = titleMatch[1].trim();
        // Don't continue — the title line might also be a phase header
      }
    }

    // Check for phase headers
    const phaseMatch = line.match(PHASE_HEADER_PATTERN);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }

    // Check for checkbox items
    const checkboxMatch = line.match(CHECKBOX_PATTERN);
    if (checkboxMatch) {
      const checked = checkboxMatch[1].toLowerCase() === 'x';
      const description = checkboxMatch[2].trim();
      steps.push({
        id: `step-${stepIndex}`,
        description,
        status: checked ? 'completed' : 'pending',
        phase: currentPhase,
      });
      stepIndex++;
      continue;
    }

    // Check for numbered list items
    const numberedMatch = line.match(NUMBERED_PATTERN);
    if (numberedMatch) {
      const description = numberedMatch[1].trim();
      steps.push({
        id: `step-${stepIndex}`,
        description,
        status: 'pending',
        phase: currentPhase,
      });
      stepIndex++;
      continue;
    }
  }

  return { title, steps };
}

/**
 * Extracts `<proposed_plan>` content from text.
 *
 * Used by OpenCode which wraps plan content in XML-style tags.
 *
 * @param text - Raw assistant message text
 * @returns Inner markdown content or null if no proposed_plan block found
 */
export function extractProposedPlan(text: string): string | null {
  const match = text.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/);
  return match ? match[1].trim() : null;
}
