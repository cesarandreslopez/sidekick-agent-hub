/**
 * @fileoverview Prompt templates for agent guidance analysis.
 *
 * Provides prompt generation functions for AI-powered analysis of
 * session data to generate instruction file suggestions.
 * Supports both CLAUDE.md and AGENTS.md depending on the active provider.
 *
 * @module utils/analysisPrompts
 */

import type { SessionAnalysisData, AnalyzedError, ToolPattern, Inefficiency, RecoveryPattern } from '../types/analysis';
import type { InstructionFileTarget } from '../types/instructionFile';

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration (e.g., "5m 30s", "2h 15m")
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Formats a number with thousands separators.
 *
 * @param n - Number to format
 * @returns Formatted number string (e.g., "12,345")
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Formats error data for the analysis prompt.
 *
 * @param errors - Array of analyzed errors
 * @returns Formatted error section
 */
function formatErrors(errors: AnalyzedError[]): string {
  if (errors.length === 0) {
    return 'None';
  }

  return errors.map(e => {
    const examples = e.examples.slice(0, 2).join('; ');
    return `- ${e.category} (${e.count}x): ${examples}`;
  }).join('\n');
}

/**
 * Formats tool patterns for the analysis prompt.
 *
 * @param patterns - Array of tool patterns
 * @returns Formatted tool usage section
 */
function formatToolPatterns(patterns: ToolPattern[]): string {
  return patterns.map(t => {
    const failurePercent = Math.round(t.failureRate * 100);
    let line = `- ${t.tool}: ${t.callCount} calls, ${failurePercent}% failure rate`;
    if (t.repeatedTargets.length > 0) {
      line += `\n  Repeated: ${t.repeatedTargets.join(', ')}`;
    }
    return line;
  }).join('\n');
}

/**
 * Formats inefficiencies for the analysis prompt.
 *
 * @param inefficiencies - Array of detected inefficiencies
 * @returns Formatted inefficiencies section
 */
function formatInefficiencies(inefficiencies: Inefficiency[]): string {
  if (inefficiencies.length === 0) {
    return 'None detected';
  }

  return inefficiencies.map(i =>
    `- ${i.type}: ${i.description} (${i.occurrences}x)`
  ).join('\n');
}

/**
 * Formats recovery patterns for the analysis prompt.
 *
 * Recovery patterns show workarounds Claude discovered after initial failures.
 *
 * @param patterns - Array of detected recovery patterns
 * @returns Formatted recovery patterns section
 */
function formatRecoveryPatterns(patterns: RecoveryPattern[]): string {
  if (patterns.length === 0) {
    return 'None detected';
  }

  return patterns.map(p =>
    `- ${p.type}: "${p.failedApproach}" failed → "${p.successfulApproach}" worked (${p.occurrences}x)\n  ${p.description}`
  ).join('\n');
}

/**
 * Formats instruction file content for the analysis prompt.
 *
 * @param content - File content or undefined
 * @param filename - Display name for the file
 * @returns Formatted content section
 */
function formatInstructionFileContent(content: string | undefined, filename: string): string {
  if (!content) {
    return `No ${filename} file found in the project root.`;
  }
  // Truncate if too long to keep prompt reasonable
  const maxLength = 4000;
  if (content.length > maxLength) {
    return content.substring(0, maxLength) + '\n\n[... truncated for brevity ...]';
  }
  return content;
}

/**
 * Builds the provider-aware guidance analysis prompt from session data.
 *
 * The prompt instructs the AI to analyze session patterns and generate
 * specific, actionable suggestions for the target instruction file.
 *
 * @param data - Structured session analysis data
 * @param target - The instruction file target for the active provider
 * @returns Complete prompt for guidance analysis
 */
export function buildGuidanceAnalysisPrompt(data: SessionAnalysisData, target: InstructionFileTarget): string {
  const primaryContent = target.primaryFile === 'CLAUDE.md' ? data.currentClaudeMd : data.currentAgentsMd;
  const secondaryContent = target.primaryFile === 'CLAUDE.md' ? data.currentAgentsMd : data.currentClaudeMd;

  let secondarySection = '';
  if (secondaryContent) {
    secondarySection = `
<secondary_file>
<filename>${target.secondaryFile}</filename>
${formatInstructionFileContent(secondaryContent, target.secondaryFile)}
</secondary_file>

Note: The secondary file above is also read by the agent. Consider its content to avoid duplicating instructions that are already covered there. Only add NEW information to ${target.primaryFile}.
`;
  }

  return `You are analyzing a coding agent session to suggest improvements for the user's ${target.primaryFile} file.

${target.primaryFile} gives the agent context about a project - coding conventions, important files, commands, things to avoid. Good content helps the agent work more efficiently.

<session_data>
<project>${data.projectPath}</project>
<duration>${formatDuration(data.sessionDuration)}</duration>
<tokens>${formatNumber(data.totalTokens)}</tokens>
</session_data>

<primary_file>
<filename>${target.primaryFile}</filename>
${formatInstructionFileContent(primaryContent, target.primaryFile)}
</primary_file>
${secondarySection}
<errors>
${formatErrors(data.errors)}
</errors>

<tool_usage>
${formatToolPatterns(data.toolPatterns)}
</tool_usage>

<inefficiencies>
${formatInefficiencies(data.inefficiencies)}
</inefficiencies>

<recovery_patterns>
${formatRecoveryPatterns(data.recoveryPatterns)}
</recovery_patterns>

<recent_activity>
${data.recentActivity.join('\n')}
</recent_activity>

## Task

Based on the session patterns above AND the current ${target.primaryFile} content (if any), suggest ONE consolidated block of text to APPEND to the end of the file.

IMPORTANT:
- Do NOT repeat content that already exists in the current ${target.primaryFile}
- Focus only on NEW information discovered from this session
- If the ${target.primaryFile} already covers a topic well, skip it
- Organize related suggestions under logical headings

Format your response EXACTLY as follows:

### Recommended Addition
**Summary:** [1-2 sentence overview of what you're adding and why]

**Append this to ${target.primaryFile}:**
\`\`\`
[Single consolidated block with all new suggestions organized by topic]
\`\`\`

**Rationale:**
- [Why suggestion 1 helps - reference the specific observed pattern]
- [Why suggestion 2 helps - reference the specific observed pattern]
- [Continue for each distinct suggestion in your block]

Be specific. Reference actual files/commands from the session data. Avoid generic advice like "write good code". Each point in your rationale should directly address something observed in this session that isn't already covered in the existing ${target.primaryFile}.

Pay special attention to <recovery_patterns> - these show workarounds discovered after failures. Document these solutions so future sessions know the right approach immediately, avoiding wasted attempts with the failed approach.

Common good additions include:
- Documenting the package manager (npm vs pnpm vs yarn) based on recovery patterns
- Noting key type definition files that get read repeatedly
- Listing commands that failed and what to use instead (from recovery patterns)
- Documenting correct file locations when files were found in different paths than expected
- Documenting project structure to reduce glob/grep spam
- Noting permission restrictions or paths to avoid`;
}

/**
 * @deprecated Use buildGuidanceAnalysisPrompt instead.
 */
export function buildClaudeMdAnalysisPrompt(data: SessionAnalysisData): string {
  const defaultTarget = {
    primaryFile: 'CLAUDE.md' as const,
    secondaryFile: 'AGENTS.md' as const,
    displayName: 'CLAUDE.md',
    tip: '',
    notFoundMessage: '',
    docsUrl: '',
  };
  return buildGuidanceAnalysisPrompt(data, defaultTarget);
}

/**
 * Parses the AI response into structured suggestions.
 *
 * Handles the consolidated format with either CLAUDE.md or AGENTS.md:
 * ### Recommended Addition
 * **Summary:** [overview]
 * **Append this to CLAUDE.md:** (or AGENTS.md)
 * ```
 * [content]
 * ```
 * **Rationale:**
 * - [reason 1]
 * - [reason 2]
 *
 * @param response - Raw response from the AI
 * @returns Array of parsed suggestions (single element for consolidated format)
 */
export function parseGuidanceSuggestions(response: string): Array<{
  title: string;
  observed: string;
  suggestion: string;
  reasoning: string;
}> {
  const suggestions: Array<{
    title: string;
    observed: string;
    suggestion: string;
    reasoning: string;
  }> = [];

  // Try new consolidated format first — accept either file name
  const summaryMatch = response.match(/\*\*Summary:\*\*\s*([^\n]+)/);
  const codeBlockMatch = response.match(/\*\*Append this to (?:CLAUDE\.md|AGENTS\.md):\*\*\s*\n```(?:\w*\n)?([\s\S]*?)\n```/);
  const rationaleMatch = response.match(/\*\*Rationale:\*\*\s*\n((?:[-•]\s*[^\n]+\n?)+)/);

  if (codeBlockMatch) {
    // Parse rationale bullet points
    let rationaleText = '';
    if (rationaleMatch) {
      const bulletPoints = rationaleMatch[1]
        .split(/\n/)
        .filter(line => line.trim().match(/^[-•]/))
        .map(line => line.replace(/^[-•]\s*/, '').trim())
        .filter(Boolean);
      rationaleText = bulletPoints.join(' | ');
    }

    suggestions.push({
      title: 'Recommended Addition',
      observed: summaryMatch?.[1]?.trim() || 'Based on session analysis',
      suggestion: codeBlockMatch[1].trim(),
      reasoning: rationaleText || 'See rationale above'
    });

    return suggestions;
  }

  // Fallback: try old multi-suggestion format for backwards compatibility
  const oldPattern = /### Suggestion \d+:\s*([^\n]+)\n\*\*Observed:\*\*\s*([^\n]+)\n\*\*Add to (?:CLAUDE\.md|AGENTS\.md):\*\*\s*\n```\n?([\s\S]*?)\n?```\n\*\*Why:\*\*\s*([^\n]+)/g;

  let match;
  while ((match = oldPattern.exec(response)) !== null) {
    suggestions.push({
      title: match[1].trim(),
      observed: match[2].trim(),
      suggestion: match[3].trim(),
      reasoning: match[4].trim()
    });
  }

  // Final fallback: more flexible pattern matching
  if (suggestions.length === 0) {
    const blocks = response.split(/### (?:Suggestion \d+:|Recommended Addition)/);
    for (const block of blocks.slice(1)) {
      const titleMatch = block.match(/^([^\n]+)/);
      const observedMatch = block.match(/\*\*(?:Observed|Summary):\*\*\s*([^\n]+)/);
      const suggestionMatch = block.match(/```(?:\w*\n)?([\s\S]*?)\n?```/);
      const whyMatch = block.match(/\*\*(?:Why|Rationale):\*\*\s*([^\n]+)/);

      if (suggestionMatch) {
        suggestions.push({
          title: titleMatch?.[1]?.trim() || 'Suggestion',
          observed: observedMatch?.[1]?.trim() || '',
          suggestion: suggestionMatch[1].trim(),
          reasoning: whyMatch?.[1]?.trim() || ''
        });
      }
    }
  }

  return suggestions;
}

/**
 * @deprecated Use parseGuidanceSuggestions instead.
 */
export const parseClaudeMdSuggestions = parseGuidanceSuggestions;
