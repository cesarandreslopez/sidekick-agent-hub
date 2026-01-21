/**
 * @fileoverview System and user prompt templates for code completions.
 *
 * Provides prompt generation functions that instruct Claude to output
 * code-only completions without conversational text or markdown.
 *
 * @module prompts
 */

import { log } from '../services/Logger';

/**
 * Patterns that indicate a conversational response rather than code.
 *
 * If Claude returns a response matching any of these patterns,
 * it means the model didn't follow instructions and the completion
 * should be filtered out.
 */
const CONVERSATIONAL_PATTERNS = [
  /^(Could|Would|Can) you/i,
  /cannot provide/i,
  /please provide/i,
  /however/i,
  /without (additional|more)/i,
];

/**
 * Meta-response patterns - Claude talking about the task instead of completing it.
 * These should be filtered for ALL file types including prose.
 */
const META_RESPONSE_PATTERNS = [
  /^I (need|cannot|can't|don't|would|could|am unable|will)/i,
  /^I'm (unable|not able|sorry|going)/i,
  /^(Sorry|Unfortunately),? I/i,
  /need (to see|more|the) (code|context|file)/i,
  /provide (an? )?(accurate|proper|correct) completion/i,
  /where the cursor is/i,
  /^To (provide|complete|help)/i,
  /^I'll (continue|complete|help|provide)/i,
  /(from|at) the cursor/i,
  /^(Here|Let me|Allow me|Sure|Okay|Of course)/i,
  /complete (the|this)? ?(text|code|sentence)/i,
  /continue (the|this)? ?(text|code|naturally)/i,
  /^Based on/i,
  /^Looking at/i,
  /^>\s*-/,  // Quoted list items from the context
];

/**
 * Generates the system prompt for completion requests.
 *
 * The system prompt instructs Claude to act as an autocomplete engine,
 * outputting only code without explanations, questions, or markdown.
 *
 * @param multiline - Whether to request multi-line (block/function) completions
 * @returns System prompt string
 *
 * @example
 * ```typescript
 * const singleLinePrompt = getSystemPrompt(false);
 * // "You are an autocomplete engine... Maximum 1-3 lines"
 *
 * const multiLinePrompt = getSystemPrompt(true);
 * // "You are an autocomplete engine... Maximum up to 10 lines"
 * ```
 */
export function getSystemPrompt(multiline: boolean, language?: string): string {
  const isProse = language && PROSE_LANGUAGES.includes(language.toLowerCase());
  const blockType = multiline ? 'block/function' : 'line/statement';

  // Character limits based on file type
  const charLimit = isProse
    ? (multiline ? '3000' : '2000')
    : (multiline ? '800' : '500');

  const lineLimit = multiline ? 'up to 10 lines' : '1-3 lines';

  log(`Prompt: multiline=${multiline}, isProse=${isProse}, blockType=${blockType}, charLimit=${charLimit}`);

  if (isProse) {
    return `Silent text insertion engine. Output goes DIRECTLY into document - not read by human first.

CRITICAL: Output raw text only. No commentary. Start with actual content immediately.

WRONG: "Let me complete the text..." or "Here's the continuation..."
RIGHT: (just the actual text that continues the document)

Rules: Match style exactly. Max ${lineLimit}, ${charLimit} chars. No first-person. No meta-talk.`;
  }

  return `Silent code insertion engine. Output goes DIRECTLY into editor - not read by human first.

CRITICAL: Output raw code only. No commentary. Start with actual code immediately.

WRONG: "Here's the code..." or "I'll complete this..."
RIGHT: (just the code that goes at cursor)

Rules: Complete ${blockType}. Max ${lineLimit}, ${charLimit} chars. No markdown/backticks. If unsure, use default (None, 0, "", []).`;
}

/**
 * Generates the user prompt for a specific completion request.
 *
 * The prompt format includes language, filename, and the code context
 * with a <CURSOR> marker indicating where completion should be inserted.
 *
 * @param language - Programming language identifier (e.g., 'typescript', 'python')
 * @param filename - Name of the file being edited
 * @param prefix - Code before the cursor position
 * @param suffix - Code after the cursor position
 * @returns User prompt string
 *
 * @example
 * ```typescript
 * const prompt = getUserPrompt(
 *   'typescript',
 *   'utils.ts',
 *   'function add(a: number, b: number): number {\n  return ',
 *   '\n}'
 * );
 * // "typescript | utils.ts\n\nfunction add(a: number, b: number): number {\n  return <CURSOR>\n}\n\nCompletion:"
 * ```
 */
export function getUserPrompt(
  language: string,
  filename: string,
  prefix: string,
  suffix: string
): string {
  return `${language} | ${filename}

${prefix}<CURSOR>${suffix}

OUTPUT (inserted at cursor):`;
}

/**
 * Cleans and validates a completion response from Claude.
 *
 * Removes markdown code block markers, filters out conversational responses,
 * and enforces length limits.
 *
 * @param text - Raw completion text from Claude
 * @param multiline - Whether this was a multi-line completion request
 * @returns Cleaned completion string, or undefined if invalid/filtered
 *
 * @example
 * ```typescript
 * // Valid completion
 * cleanCompletion('a + b;', false); // Returns 'a + b;'
 *
 * // Markdown removal
 * cleanCompletion('```typescript\na + b;\n```', false); // Returns 'a + b;'
 *
 * // Conversational filtering
 * cleanCompletion('I need more context to complete this.', false); // Returns undefined
 *
 * // Length filtering
 * cleanCompletion('very long response...', false); // Returns undefined if > 200 chars
 * ```
 */
/**
 * File types where prose completions are valid.
 */
const PROSE_LANGUAGES = [
  'markdown',
  'md',
  'plaintext',
  'text',
  'txt',
  'restructuredtext',
  'asciidoc',
  'latex',
  'tex',
  'html',
  'xml',
];

export function cleanCompletion(
  text: string,
  multiline: boolean,
  language?: string
): string | undefined {
  const isProse = language && PROSE_LANGUAGES.includes(language.toLowerCase());

  // Limits must match what we tell Claude in getSystemPrompt
  let maxLength: number;
  if (multiline) {
    maxLength = isProse ? 3000 : 800;
  } else {
    maxLength = isProse ? 2000 : 500;
  }

  log(`Clean: isProse=${isProse}, maxLength=${maxLength}`);

  // Remove markdown code blocks (but not for markdown files)
  let cleaned = text;
  if (!isProse) {
    cleaned = text
      // Remove opening code block with optional language (```json, ```typescript, etc.)
      .replace(/^\s*```[\w-]*\s*\n?/gm, '')
      // Remove closing code block
      .replace(/\n?\s*```\s*$/gm, '')
      // Also handle inline code blocks that wrap the entire response
      .replace(/^```[\w-]*\n([\s\S]*?)\n```$/m, '$1')
      .trim();

    // If it still starts with ```, just strip it
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```[\w-]*\s*/, '');
      log(`Clean: stripped remaining code fence`);
    }
  } else {
    cleaned = text.trim();
  }

  // Check for meta-responses (Claude talking about the task) - applies to ALL file types
  for (const pattern of META_RESPONSE_PATTERNS) {
    if (pattern.test(cleaned)) {
      log(`Clean: rejected - meta-response: ${pattern}`);
      return undefined;
    }
  }

  // Check for conversational patterns (skip for prose files)
  if (!isProse) {
    for (const pattern of CONVERSATIONAL_PATTERNS) {
      if (pattern.test(cleaned)) {
        log(`Clean: rejected - matched conversational pattern: ${pattern}`);
        return undefined;
      }
    }
  }

  // If too long, try to truncate intelligently
  if (cleaned.length > maxLength) {
    log(`Clean: too long (${cleaned.length} > ${maxLength}), attempting truncation (isProse=${isProse}, multiline=${multiline})`);

    if (isProse) {
      // For prose, truncate at sentence or paragraph boundary
      const truncateAt = Math.min(cleaned.length, maxLength);

      // Try paragraph boundary first (double newline)
      const lastPara = cleaned.lastIndexOf('\n\n', truncateAt);
      if (lastPara > maxLength * 0.5) {
        cleaned = cleaned.substring(0, lastPara).trim();
        log(`Clean: truncated at paragraph boundary (${cleaned.length} chars)`);
      } else {
        // Try sentence boundary
        const lastPeriod = cleaned.lastIndexOf('. ', truncateAt);
        const lastQuestion = cleaned.lastIndexOf('? ', truncateAt);
        const lastExclaim = cleaned.lastIndexOf('! ', truncateAt);
        const cutPoint = Math.max(lastPeriod, lastQuestion, lastExclaim);

        if (cutPoint > maxLength * 0.3) {
          cleaned = cleaned.substring(0, cutPoint + 1).trim();
          log(`Clean: truncated at sentence boundary (${cleaned.length} chars)`);
        } else {
          // Just truncate at word boundary
          const lastSpace = cleaned.lastIndexOf(' ', maxLength);
          if (lastSpace > maxLength * 0.3) {
            cleaned = cleaned.substring(0, lastSpace).trim();
            log(`Clean: truncated at word boundary (${cleaned.length} chars)`);
          } else {
            cleaned = cleaned.substring(0, maxLength).trim();
            log(`Clean: hard truncated (${cleaned.length} chars)`);
          }
        }
      }
    } else if (!multiline) {
      // For code single-line, take first line only
      const firstNewline = cleaned.indexOf('\n');
      if (firstNewline > 0 && firstNewline <= maxLength) {
        cleaned = cleaned.substring(0, firstNewline).trim();
        log(`Clean: truncated to first line (${cleaned.length} chars)`);
      } else {
        // Try truncating at last complete statement (semicolon, bracket, etc.)
        const truncateAt = Math.min(cleaned.length, maxLength);
        const lastSemi = cleaned.lastIndexOf(';', truncateAt);
        const lastBrace = cleaned.lastIndexOf('}', truncateAt);
        const lastParen = cleaned.lastIndexOf(')', truncateAt);
        const cutPoint = Math.max(lastSemi, lastBrace, lastParen);

        if (cutPoint > 20) {
          cleaned = cleaned.substring(0, cutPoint + 1).trim();
          log(`Clean: truncated at statement boundary (${cleaned.length} chars)`);
        } else {
          log(`Clean: rejected - too long and no good truncation point`);
          return undefined;
        }
      }
    } else {
      // For code multiline, try to truncate at a logical boundary
      const truncateAt = Math.min(cleaned.length, maxLength);
      const lastBrace = cleaned.lastIndexOf('}', truncateAt);
      const lastSemi = cleaned.lastIndexOf(';', truncateAt);
      const cutPoint = Math.max(lastBrace, lastSemi);

      if (cutPoint > maxLength * 0.5) {
        cleaned = cleaned.substring(0, cutPoint + 1).trim();
        log(`Clean: truncated at code boundary (${cleaned.length} chars)`);
      } else {
        log(`Clean: rejected - too long for multiline code`);
        return undefined;
      }
    }
  }

  if (!cleaned) {
    log(`Clean: rejected - empty after cleaning`);
    return undefined;
  }

  return cleaned;
}

/**
 * Patterns indicating a conversational transform response rather than code.
 */
const TRANSFORM_CONVERSATIONAL_PATTERNS = [
  /^Here/i,
  /^The transformed/i,
  /^I've/i,
  /^I have/i,
];

/**
 * Generates the system prompt for code transformation requests.
 *
 * Instructs Claude to act as a code transformation assistant,
 * outputting only the transformed code without explanations.
 *
 * @returns System prompt string for transforms
 *
 * @example
 * ```typescript
 * const systemPrompt = getTransformSystemPrompt();
 * // "You are a code transformation assistant..."
 * ```
 */
export function getTransformSystemPrompt(): string {
  return `You are a code transformation assistant. Transform the provided code according to the user's instruction.

RULES:
- Output ONLY the transformed code
- Preserve the code's functionality unless the instruction changes it
- Maintain the same programming language
- Keep the same indentation style
- NO explanations before or after the code
- NO markdown code blocks
- If the instruction is unclear, make a reasonable interpretation`;
}

/**
 * Generates the user prompt for a code transformation request.
 *
 * Includes the language, code to transform, optional context before/after,
 * and the transformation instruction.
 *
 * @param code - The code to transform
 * @param instruction - What transformation to apply
 * @param language - Programming language identifier
 * @param prefix - Optional code context before the selection
 * @param suffix - Optional code context after the selection
 * @returns User prompt string for transforms
 *
 * @example
 * ```typescript
 * const prompt = getTransformUserPrompt(
 *   'function add(a, b) { return a + b; }',
 *   'Add TypeScript types',
 *   'typescript'
 * );
 * ```
 */
export function getTransformUserPrompt(
  code: string,
  instruction: string,
  language: string,
  prefix?: string,
  suffix?: string
): string {
  let prompt = `Language: ${language}\n\n`;

  if (prefix) {
    prompt += `Context before:\n${prefix}\n\n`;
  }

  prompt += `Code to transform:\n${code}\n\n`;

  if (suffix) {
    prompt += `Context after:\n${suffix}\n\n`;
  }

  prompt += `Instruction: ${instruction}\n\nTransformed code:`;

  return prompt;
}

/**
 * Cleans and validates a transform response from Claude.
 *
 * Removes markdown code block markers and filters out conversational
 * responses that don't contain just code.
 *
 * @param text - Raw transform response text from Claude
 * @returns Cleaned code string, or undefined if invalid/filtered
 *
 * @example
 * ```typescript
 * // Valid transform
 * cleanTransformResponse('function add(a: number, b: number): number { return a + b; }');
 * // Returns the code
 *
 * // Markdown removal
 * cleanTransformResponse('```typescript\nconst x = 1;\n```');
 * // Returns 'const x = 1;'
 *
 * // Conversational filtering
 * cleanTransformResponse("Here's the transformed code:\nconst x = 1;");
 * // Returns 'const x = 1;' (extracts code after newline)
 * ```
 */
export function cleanTransformResponse(text: string): string | undefined {
  // Remove markdown code blocks (```language ... ```)
  let cleaned = text
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Check for conversational prefixes
  for (const pattern of TRANSFORM_CONVERSATIONAL_PATTERNS) {
    if (pattern.test(cleaned)) {
      // Try to extract code after first newline
      const newlineIndex = cleaned.indexOf('\n');
      if (newlineIndex !== -1) {
        cleaned = cleaned.slice(newlineIndex + 1).trim();
        // Remove any remaining markdown blocks after extraction
        cleaned = cleaned
          .replace(/^```[\w]*\n?/, '')
          .replace(/\n?```$/, '')
          .trim();
      } else {
        // No newline found, can't extract code
        return undefined;
      }
    }
  }

  return cleaned || undefined;
}

/**
 * Style options for commit message generation.
 */
export type CommitMessageStyle = 'conventional' | 'simple';

/**
 * Generates the system prompt for commit message generation.
 *
 * Instructs Claude to generate a single-line commit message in the specified style
 * without any markdown, explanations, or formatting.
 *
 * @param style - The commit message style ('conventional' or 'simple')
 * @returns System prompt string for commit message generation
 */
export function getCommitMessageSystemPrompt(style: CommitMessageStyle = 'conventional'): string {
  if (style === 'simple') {
    return `You are a Git commit message generator. Generate a single, concise commit message.

REQUIREMENTS:
- Write a clear, imperative description of the change
- Start with a capitalized verb: Add, Fix, Update, Remove, Refactor, Improve, Create, Delete, Move, Rename
- Keep message under 50 characters
- Output ONLY the commit message (single line)
- No markdown, no backticks, no code blocks
- No explanations or meta-commentary
- If multiple changes, describe the primary change`;
  }

  return `You are a Git commit message generator. Generate a single, concise commit message.

REQUIREMENTS:
- Use Conventional Commits format: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
- Keep description under 50 characters
- Output ONLY the commit message (single line)
- No markdown, no backticks, no code blocks
- No explanations or meta-commentary
- If multiple changes, choose the primary type`;
}

/**
 * Generates the user prompt for commit message generation.
 *
 * @param diff - The git diff text to analyze
 * @param guidance - Optional user guidance for how to generate the message
 * @returns User prompt string containing the diff
 */
export function getCommitMessageUserPrompt(diff: string, guidance?: string): string {
  let prompt = '';

  // Put guidance FIRST so it's not buried after a long diff
  if (guidance && guidance.trim()) {
    prompt += `IMPORTANT - Follow this guidance when writing the commit message: ${guidance.trim()}

`;
  }

  prompt += `Generate a commit message for this diff:

${diff}

COMMIT MESSAGE:`;

  return prompt;
}

/**
 * Cleans and validates a commit message response from Claude.
 *
 * Removes markdown formatting, quotes, and explanatory text.
 * Returns null if the response doesn't look like a valid commit message.
 *
 * @param text - Raw response text from Claude
 * @returns Cleaned commit message, or null if invalid
 */
export function cleanCommitMessage(text: string): string | null {
  const cleaned = text
    .trim()
    // Remove markdown code blocks
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    // Remove quotes if wrapped
    .replace(/^["']|["']$/g, '')
    .trim()
    // Take only first line (in case Claude added explanation)
    .split('\n')[0]
    .trim();

  // Validate format and length
  if (!cleaned || cleaned.length > 100) {
    return null;
  }

  // Reject explanatory text (similar to META_RESPONSE_PATTERNS)
  if (/^(here|the|this|i['']ve|i have|let me|sure|okay|certainly|of course)/i.test(cleaned)) {
    return null;
  }

  // Must be at least 5 characters to be a reasonable message
  if (cleaned.length < 5) {
    return null;
  }

  return cleaned;
}
