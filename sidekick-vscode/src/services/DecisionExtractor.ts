/**
 * @fileoverview Pure functions to extract decisions from session data.
 *
 * Four extraction sources:
 * 1. Recovery patterns — when Claude switches approach after a failure
 * 2. User questions — explicit AskUserQuestion tool calls
 * 3. Plan mode — EnterPlanMode/ExitPlanMode pairs
 * 4. Text patterns — regex-matched decision language in assistant responses
 *
 * All functions are pure (no side effects) for easy testing.
 *
 * @module services/DecisionExtractor
 */

import { randomUUID } from 'crypto';
import type { RecoveryPattern } from '../types/analysis';
import type { ToolCall } from '../types/claudeSession';
import type { SessionAnalysisData } from '../types/analysis';
import type { DecisionEntry } from '../types/decisionLog';

/**
 * Extracts decisions from recovery patterns (approach switches after failures).
 */
export function fromRecoveryPatterns(
  patterns: RecoveryPattern[],
  sessionId: string
): DecisionEntry[] {
  return patterns.map(pattern => ({
    id: randomUUID(),
    description: pattern.description,
    rationale: `${pattern.failedApproach} failed, switched to ${pattern.successfulApproach}`,
    alternatives: [pattern.failedApproach],
    chosenOption: pattern.successfulApproach,
    source: 'recovery_pattern' as const,
    sessionId,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Extracts decisions from AskUserQuestion tool calls.
 */
export function fromUserQuestions(
  toolCalls: ToolCall[],
  sessionId: string
): DecisionEntry[] {
  const entries: DecisionEntry[] = [];

  for (const call of toolCalls) {
    if (call.name !== 'AskUserQuestion') continue;

    const input = call.input as {
      questions?: Array<{
        question?: string;
        options?: Array<{ label?: string }>;
      }>;
    };

    if (!input.questions || !Array.isArray(input.questions)) continue;

    for (const q of input.questions) {
      if (!q.question) continue;

      const alternatives = (q.options ?? [])
        .map(o => o.label)
        .filter((l): l is string => typeof l === 'string' && l.length > 0);

      entries.push({
        id: randomUUID(),
        description: q.question,
        rationale: 'Explicit user decision point',
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        chosenOption: '(awaiting result)',
        source: 'user_question',
        sessionId,
        timestamp: call.timestamp.toISOString(),
      });
    }
  }

  return entries;
}

/**
 * Extracts decisions from plan mode tool calls (EnterPlanMode/ExitPlanMode pairs).
 */
export function fromPlanMode(
  toolCalls: ToolCall[],
  sessionId: string
): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  const enterTimes: string[] = [];

  for (const call of toolCalls) {
    if (call.name === 'EnterPlanMode') {
      enterTimes.push(call.timestamp.toISOString());
    } else if (call.name === 'ExitPlanMode') {
      const enterTime = enterTimes.shift();
      const exitTime = call.timestamp.toISOString();

      let rationale = 'Explicit planning session';
      if (enterTime) {
        const durationMs = new Date(exitTime).getTime() - new Date(enterTime).getTime();
        const durationMin = Math.round(durationMs / 60000);
        if (durationMin > 0) {
          rationale = `Explicit planning session (${durationMin}min)`;
        }
      }

      entries.push({
        id: randomUUID(),
        description: 'Plan mode session completed',
        rationale,
        chosenOption: 'Plan approved',
        source: 'plan_mode',
        sessionId,
        timestamp: exitTime,
      });
    }
  }

  return entries;
}

// Conservative regex patterns (high-precision, lower recall)
const DECISION_PATTERNS = [
  /(?:I'll|I will|Let's|We'll) (?:use|go with|opt for) (.{3,60}) (?:because|since|as) (.{5,100})/i,
  /(?:chose|choosing|decided on|going with) (.{3,60}) (?:over|instead of) (.{3,60})/i,
];

/**
 * Extracts decisions from assistant text using regex patterns.
 */
export function fromAssistantTexts(
  texts: Array<{ text: string; timestamp: string }>,
  sessionId: string
): DecisionEntry[] {
  const entries: DecisionEntry[] = [];

  for (const { text, timestamp } of texts) {
    for (const pattern of DECISION_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;

      const chosenOption = match[1].trim();
      const rationale = match[2].trim();

      // Quality gate: skip if too short
      if (chosenOption.length < 3 || rationale.length < 10) continue;

      // For the "over/instead of" pattern, extract the alternative
      const alternatives: string[] = [];
      if (match[2] && /over|instead of/i.test(text)) {
        alternatives.push(match[2].trim());
      }

      entries.push({
        id: randomUUID(),
        description: `Use ${chosenOption}`,
        rationale,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        chosenOption,
        source: 'text_pattern',
        sessionId,
        timestamp,
      });

      // Only take the first match per text block
      break;
    }
  }

  return entries;
}

/**
 * Generates a deduplication fingerprint for a decision entry.
 */
function fingerprint(entry: DecisionEntry): string {
  return `${entry.source}::${entry.description.toLowerCase().trim()}`;
}

/**
 * Top-level extraction: combines all four sources and deduplicates.
 */
export function extractDecisions(
  analysisData: SessionAnalysisData | null,
  toolCalls: ToolCall[],
  assistantTexts: Array<{ text: string; timestamp: string }>,
  sessionId: string
): DecisionEntry[] {
  const all: DecisionEntry[] = [];

  if (analysisData?.recoveryPatterns) {
    all.push(...fromRecoveryPatterns(analysisData.recoveryPatterns, sessionId));
  }

  all.push(...fromUserQuestions(toolCalls, sessionId));
  all.push(...fromPlanMode(toolCalls, sessionId));
  all.push(...fromAssistantTexts(assistantTexts, sessionId));

  // Deduplicate by description+source fingerprint
  const seen = new Set<string>();
  return all.filter(entry => {
    const fp = fingerprint(entry);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}
