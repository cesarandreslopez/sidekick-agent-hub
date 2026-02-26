/**
 * Shared plan extraction from session events.
 *
 * Handles all three providers:
 * - Claude Code: EnterPlanMode/ExitPlanMode tool calls with accumulated markdown
 * - OpenCode: <proposed_plan> XML blocks in assistant messages
 * - Codex: UpdatePlan tool calls with structured approach arrays
 */

import type { FollowEvent } from '../watchers/types';

/** Checkbox pattern: `- [ ] text` or `- [x] text` */
const CHECKBOX_PATTERN = /^[-*]\s+\[([ xX])\]\s+(.+)/;

/** Numbered list pattern: `1. text` or `1) text` */
const NUMBERED_PATTERN = /^\d+[.)]\s+(.+)/;

/** Bullet point pattern: `- Step` or `* Step` (excluding checkboxes) */
const BULLET_PATTERN = /^[-*]\s+(?!\[[ xX]\])(.+)/;

/** Phase header pattern: `## Phase 1: Setup` */
const PHASE_HEADER_PATTERN = /^#{2,4}\s+(?:Phase|Step|Stage)\s*\d*[:.]\s*(.+)/i;

/** Generic H1/H2 header for title extraction */
const TITLE_HEADER_PATTERN = /^#{1,2}\s+(.+)/;

/** Complexity keywords */
const EXPLICIT_COMPLEXITY_PATTERN = /\[(high|medium|low)\]|\((complex|simple)\)/i;
const HIGH_COMPLEXITY_KEYWORDS = /\b(refactor|migrate|rewrite|redesign|overhaul|rearchitect)\b/i;
const LOW_COMPLEXITY_KEYWORDS = /\b(update|fix|tweak|rename|adjust|bump|typo)\b/i;

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type PlanStepComplexity = 'low' | 'medium' | 'high';

export interface ExtractedPlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  phase?: string;
  complexity?: PlanStepComplexity;
}

export interface ExtractedPlan {
  title: string;
  steps: ExtractedPlanStep[];
  source: 'claude-code' | 'opencode' | 'codex';
  rawMarkdown?: string;
}

function inferComplexity(description: string): PlanStepComplexity | undefined {
  const explicitMatch = description.match(EXPLICIT_COMPLEXITY_PATTERN);
  if (explicitMatch) {
    const marker = (explicitMatch[1] || explicitMatch[2]).toLowerCase();
    if (marker === 'high' || marker === 'complex') return 'high';
    if (marker === 'low' || marker === 'simple') return 'low';
    return 'medium';
  }
  if (HIGH_COMPLEXITY_KEYWORDS.test(description)) return 'high';
  if (LOW_COMPLEXITY_KEYWORDS.test(description)) return 'low';
  return undefined;
}

/**
 * Parses plan markdown into structured plan steps.
 */
export function parsePlanMarkdown(markdown: string): { title?: string; steps: ExtractedPlanStep[] } {
  if (!markdown || !markdown.trim()) return { steps: [] };

  const lines = markdown.split('\n');
  const steps: ExtractedPlanStep[] = [];
  let title: string | undefined;
  let currentPhase: string | undefined;
  let stepIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!title) {
      const titleMatch = line.match(TITLE_HEADER_PATTERN);
      if (titleMatch) title = titleMatch[1].trim();
    }

    const phaseMatch = line.match(PHASE_HEADER_PATTERN);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX_PATTERN);
    if (checkboxMatch) {
      const checked = checkboxMatch[1].toLowerCase() === 'x';
      const description = checkboxMatch[2].trim();
      steps.push({
        id: `step-${stepIndex}`,
        description,
        status: checked ? 'completed' : 'pending',
        phase: currentPhase,
        complexity: inferComplexity(description),
      });
      stepIndex++;
      continue;
    }

    const numberedMatch = line.match(NUMBERED_PATTERN);
    if (numberedMatch) {
      const description = numberedMatch[1].trim();
      steps.push({
        id: `step-${stepIndex}`,
        description,
        status: 'pending',
        phase: currentPhase,
        complexity: inferComplexity(description),
      });
      stepIndex++;
      continue;
    }

    const bulletMatch = line.match(BULLET_PATTERN);
    if (bulletMatch) {
      const raw = bulletMatch[1].trim();
      if (raw.length <= 3) continue; // skip trivially short lines
      // Normalize bold-colon patterns: **Setup**: desc → Setup: desc
      const description = raw.replace(/\*\*(.+?)\*\*:\s*/, '$1: ');
      steps.push({
        id: `step-${stepIndex}`,
        description,
        status: 'pending',
        phase: currentPhase,
        complexity: inferComplexity(description),
      });
      stepIndex++;
      continue;
    }
  }

  return { title, steps };
}

/**
 * Extracts <proposed_plan> content from text.
 */
export function extractProposedPlan(text: string): string | null {
  const match = text.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/);
  return match ? match[1].trim() : null;
}

/**
 * Extracts full untruncated text from event.raw message content blocks.
 * Falls back to event.summary if raw is unavailable.
 */
function extractFullTextFromRaw(event: FollowEvent): string | null {
  const raw = event.raw as Record<string, unknown> | undefined;
  const message = raw?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  // Fall back to summary (may be truncated, but better than nothing)
  return event.summary || null;
}

/**
 * Stateful plan extractor for use with FollowEvent streams.
 *
 * Handles all three providers:
 * - Claude Code: EnterPlanMode/ExitPlanMode tool calls
 * - OpenCode: <proposed_plan> blocks in assistant text
 * - Codex: UpdatePlan tool calls
 */
export class PlanExtractor {
  private _plan: ExtractedPlan | null = null;
  private _planModeActive = false;
  private _planTexts: string[] = [];
  private _planFileContent: string | null = null;
  private _planFilePath: string | null = null;
  private readonly _readFile: ((path: string) => string | null) | null;

  constructor(readFile?: (path: string) => string | null) {
    this._readFile = readFile ?? null;
  }

  get plan(): ExtractedPlan | null {
    return this._plan;
  }

  reset(): void {
    this._plan = null;
    this._planModeActive = false;
    this._planTexts = [];
    this._planFileContent = null;
    this._planFilePath = null;
  }

  /**
   * Process a FollowEvent and extract plan data if present.
   * Returns true if the plan was updated.
   */
  processEvent(event: FollowEvent): boolean {
    // Codex: UpdatePlan tool calls
    if (event.type === 'tool_use' && event.toolName === 'UpdatePlan') {
      return this.extractCodexPlan(event);
    }

    // Claude Code: EnterPlanMode
    if (event.type === 'tool_use' && event.toolName === 'EnterPlanMode') {
      this._planModeActive = true;
      this._planTexts = [];
      this._planFileContent = null;
      this._planFilePath = null;
      return false;
    }

    // Claude Code: ExitPlanMode
    if (event.type === 'tool_use' && event.toolName === 'ExitPlanMode') {
      return this.finalizePlanMode();
    }

    // Capture Write/Edit tool calls to plan files during plan mode
    if (this._planModeActive && event.type === 'tool_use') {
      const raw = event.raw as Record<string, unknown> | undefined;
      const input = raw?.input as Record<string, unknown> | undefined;
      const filePath = input?.file_path as string | undefined;

      if (event.toolName === 'Write') {
        const content = input?.content as string | undefined;
        if (filePath && content && filePath.includes('.claude/plans/')) {
          this._planFileContent = content;
          this._planFilePath = filePath;
        }
      } else if (event.toolName === 'Edit') {
        // Edit contains a diff, not full content — capture path for disk-read fallback
        if (filePath && filePath.includes('.claude/plans/')) {
          this._planFilePath = filePath;
        }
      }
    }

    // Accumulate text during plan mode (Claude Code)
    // Extract full text from event.raw to avoid truncated summaries
    if (this._planModeActive && event.type === 'assistant') {
      const fullText = extractFullTextFromRaw(event);
      if (fullText) {
        this._planTexts.push(fullText);
      }
    }

    // OpenCode / Codex: <proposed_plan> blocks
    // Check raw message content first (untruncated), then fall back to summary
    if (event.type === 'assistant') {
      const raw = event.raw as Record<string, unknown> | undefined;
      const message = raw?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            const planText = extractProposedPlan(b.text);
            if (planText) {
              return this.extractFromMarkdown(planText, this.getSource(event));
            }
          }
        }
      }

      // Fall back to summary (may work for short plans)
      if (event.summary) {
        const proposed = extractProposedPlan(event.summary);
        if (proposed) {
          return this.extractFromMarkdown(proposed, this.getSource(event));
        }
      }
    }

    return false;
  }

  private getSource(event: FollowEvent): 'claude-code' | 'opencode' | 'codex' {
    if (event.providerId === 'opencode') return 'opencode';
    if (event.providerId === 'codex') return 'codex';
    return 'claude-code';
  }

  private extractCodexPlan(event: FollowEvent): boolean {
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw?.input) return false;
    const input = raw.input as Record<string, unknown>;

    // Codex UpdatePlan can use either approach[] or plan[] format
    const approach = (input.approach ?? input.plan) as unknown[] | undefined;
    if (!approach || !Array.isArray(approach)) return false;

    const steps: ExtractedPlanStep[] = [];
    for (let i = 0; i < approach.length; i++) {
      const entry = approach[i];
      if (typeof entry === 'string') {
        steps.push({
          id: `step-${i}`,
          description: entry,
          status: 'pending',
          complexity: inferComplexity(entry),
        });
      } else if (typeof entry === 'object' && entry !== null) {
        const obj = entry as Record<string, unknown>;
        const desc = String(obj.step || obj.description || '').trim();
        if (!desc) continue;
        const rawStatus = String(obj.status || 'pending').toLowerCase();
        let status: PlanStepStatus;
        if (rawStatus === 'completed') status = 'completed';
        else if (rawStatus === 'in_progress' || rawStatus === 'in-progress') status = 'in_progress';
        else status = 'pending';
        steps.push({
          id: `step-${i}`,
          description: desc,
          status,
          complexity: inferComplexity(desc),
        });
      }
    }

    if (steps.length > 0) {
      this._plan = {
        title: (input.title as string) || 'Plan',
        steps,
        source: 'codex',
      };
      return true;
    }
    return false;
  }

  private finalizePlanMode(): boolean {
    this._planModeActive = false;

    // Prefer plan file content (from Write tool) → accumulated assistant text → disk read fallback
    const markdown = this._planFileContent
      || (this._planTexts.length > 0 ? this._planTexts.join('\n') : null)
      || (this._planFilePath && this._readFile ? this._readFile(this._planFilePath) : null);
    this._planFileContent = null;
    this._planFilePath = null;
    this._planTexts = [];

    if (!markdown) return false;
    return this.extractFromMarkdown(markdown, 'claude-code');
  }

  private extractFromMarkdown(markdown: string, source: 'claude-code' | 'opencode' | 'codex'): boolean {
    const parsed = parsePlanMarkdown(markdown);

    this._plan = {
      title: parsed.title || 'Plan',
      steps: parsed.steps,
      source,
      rawMarkdown: markdown,
    };
    return true;
  }
}
