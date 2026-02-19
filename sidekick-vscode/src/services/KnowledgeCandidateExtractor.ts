/**
 * @fileoverview Pure functions to extract knowledge note candidates from session data.
 *
 * Three extraction sources:
 * 1. Gotcha candidates: Repeated errors (3+) on the same file path
 * 2. Pattern candidates: Recovery patterns involving file operations
 * 3. Guideline candidates: Guidance suggestions mentioning specific workspace files
 *
 * All functions are pure (no side effects) for easy testing.
 *
 * @module services/KnowledgeCandidateExtractor
 */

import type { AnalyzedError, RecoveryPattern } from '../types/analysis';
import type { ToolCall } from '../types/claudeSession';
import type { KnowledgeCandidateDisplay } from '../types/knowledgeNote';

/**
 * Extracts gotcha candidates from repeated errors on the same file.
 *
 * Looks for files that appear in 3+ error messages, indicating a common
 * source of trouble that should be documented.
 */
export function extractGotchaCandidates(
  _errors: AnalyzedError[],
  toolCalls: ToolCall[],
  projectPath: string
): KnowledgeCandidateDisplay[] {
  const candidates: KnowledgeCandidateDisplay[] = [];

  // Build a map of file paths -> error messages from tool call results
  const fileErrors = new Map<string, string[]>();

  for (const call of toolCalls) {
    if (!call.isError) continue;

    // Extract file path from tool input
    const filePath = extractFilePathFromToolCall(call, projectPath);
    if (!filePath) continue;

    const errorMsg = call.errorMessage?.slice(0, 200) ?? 'Unknown error';

    const existing = fileErrors.get(filePath) || [];
    existing.push(errorMsg);
    fileErrors.set(filePath, existing);
  }

  // Files with 3+ errors become gotcha candidates
  for (const [filePath, errorMsgs] of fileErrors) {
    if (errorMsgs.length < 3) continue;

    // Summarize the error pattern
    const uniqueErrors = [...new Set(errorMsgs)].slice(0, 3);
    const evidence = uniqueErrors.join('; ');

    candidates.push({
      noteType: 'gotcha',
      content: `This file caused ${errorMsgs.length} errors during the session. Common issues: ${evidence}`,
      filePath,
      source: 'auto_error',
      confidence: Math.min(0.9, 0.5 + errorMsgs.length * 0.1),
      evidence: `${errorMsgs.length} error occurrences on this file`,
    });
  }

  return candidates;
}

/**
 * Extracts pattern candidates from recovery patterns involving file operations.
 *
 * When Claude tries approach A on a file and switches to approach B,
 * this is a pattern worth documenting.
 */
export function extractPatternCandidates(
  recoveryPatterns: RecoveryPattern[],
  _toolCalls: ToolCall[],
  projectPath: string
): KnowledgeCandidateDisplay[] {
  const candidates: KnowledgeCandidateDisplay[] = [];

  // Find recovery patterns that reference specific files
  for (const pattern of recoveryPatterns) {
    // Look for file paths in the pattern description or approaches
    const filePath = extractFilePathFromText(
      `${pattern.description} ${pattern.failedApproach} ${pattern.successfulApproach}`,
      projectPath
    );

    if (!filePath) continue;

    candidates.push({
      noteType: 'pattern',
      content: `${pattern.description}: Use "${pattern.successfulApproach}" instead of "${pattern.failedApproach}"`,
      filePath,
      source: 'auto_recovery',
      confidence: 0.7,
      evidence: `Recovery pattern: tried ${pattern.failedApproach}, succeeded with ${pattern.successfulApproach}`,
    });
  }

  return candidates;
}

/**
 * Extracts guideline candidates from guidance suggestions that mention workspace files.
 */
export function extractGuidelineCandidates(
  suggestions: Array<{ title: string; observed: string; suggestion: string; reasoning: string }>,
  projectPath: string
): KnowledgeCandidateDisplay[] {
  const candidates: KnowledgeCandidateDisplay[] = [];

  for (const suggestion of suggestions) {
    const text = `${suggestion.observed} ${suggestion.suggestion} ${suggestion.reasoning}`;
    const filePath = extractFilePathFromText(text, projectPath);

    if (!filePath) continue;

    candidates.push({
      noteType: 'guideline',
      content: suggestion.suggestion,
      filePath,
      source: 'auto_guidance',
      confidence: 0.6,
      evidence: `Guidance suggestion: ${suggestion.title}`,
    });
  }

  return candidates;
}

/**
 * Top-level extraction combining all sources.
 */
export function extractKnowledgeCandidates(
  errors: AnalyzedError[],
  recoveryPatterns: RecoveryPattern[],
  toolCalls: ToolCall[],
  suggestions: Array<{ title: string; observed: string; suggestion: string; reasoning: string }>,
  projectPath: string
): KnowledgeCandidateDisplay[] {
  const all: KnowledgeCandidateDisplay[] = [];

  all.push(...extractGotchaCandidates(errors, toolCalls, projectPath));
  all.push(...extractPatternCandidates(recoveryPatterns, toolCalls, projectPath));
  all.push(...extractGuidelineCandidates(suggestions, projectPath));

  // Deduplicate by filePath + noteType
  const seen = new Set<string>();
  return all.filter(candidate => {
    const key = `${candidate.filePath}::${candidate.noteType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Helpers ---

function extractFilePathFromToolCall(call: ToolCall, projectPath: string): string | undefined {
  const rawPath = (call.input.file_path || call.input.path) as string | undefined;
  if (!rawPath || typeof rawPath !== 'string') return undefined;
  return toRelativePath(rawPath, projectPath);
}

function extractFilePathFromText(text: string, projectPath: string): string | undefined {
  // Match common file path patterns: /path/to/file.ext or src/path/file.ext
  const pathPatterns = [
    /(?:^|\s)((?:\/[\w.-]+)+\/[\w.-]+\.\w+)/,
    /(?:^|\s)((?:src|lib|test|tests|app)\/[\w./-]+\.\w+)/,
  ];

  for (const pattern of pathPatterns) {
    const match = pattern.exec(text);
    if (match) {
      return toRelativePath(match[1].trim(), projectPath);
    }
  }

  return undefined;
}

function toRelativePath(filePath: string, projectPath: string): string {
  if (filePath.startsWith(projectPath)) {
    const relative = filePath.slice(projectPath.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}
