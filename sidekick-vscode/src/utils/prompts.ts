/**
 * @fileoverview System and user prompt templates for code completions.
 *
 * Provides prompt generation functions that instruct Claude to output
 * code-only completions without conversational text or markdown.
 *
 * @module prompts
 */

import { log } from '../services/Logger';
import type { ErrorContext } from '../types/errorExplanation';
import type { ComplexityLevel } from '../types/rsvp';
import { COMPLEXITY_LABELS } from '../types/rsvp';
import { stripMarkdownFences } from './markdownUtils';

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
  /^However,/i,
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
    cleaned = stripMarkdownFences(text)
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
  return `You are a code transformation assistant. Transform the code in the <code> tags according to the instruction in <instruction> tags.

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
    prompt += `<context_before>\n${prefix}\n</context_before>\n\n`;
  }

  prompt += `<code>\n${code}\n</code>\n\n`;

  if (suffix) {
    prompt += `<context_after>\n${suffix}\n</context_after>\n\n`;
  }

  prompt += `<instruction>${instruction}</instruction>\n\nTransformed code:`;

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
  let cleaned = stripMarkdownFences(text).trim();

  // Check for conversational prefixes
  for (const pattern of TRANSFORM_CONVERSATIONAL_PATTERNS) {
    if (pattern.test(cleaned)) {
      // Try to extract code after first newline
      const newlineIndex = cleaned.indexOf('\n');
      if (newlineIndex !== -1) {
        cleaned = cleaned.slice(newlineIndex + 1).trim();
        // Remove any remaining markdown blocks after extraction
        cleaned = stripMarkdownFences(cleaned).trim();
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
    prompt += `<guidance>${guidance.trim()}</guidance>

`;
  }

  prompt += `Generate a commit message for this diff:

<diff>
${diff}
</diff>

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
  const cleaned = stripMarkdownFences(text.trim())
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

/**
 * Generates the system prompt for documentation generation.
 *
 * Instructs Claude to generate language-specific documentation in the
 * appropriate format (JSDoc for JS/TS, PEP 257 for Python, etc.).
 *
 * @param language - Programming language identifier
 * @returns System prompt string for documentation generation
 */
export function getDocGenerationSystemPrompt(language: string): string {
  const lang = language.toLowerCase();

  if (lang === 'typescript' || lang === 'javascript') {
    return `You are a JSDoc documentation generator. Generate JSDoc comments for code.

OUTPUT FORMAT - JSDoc block comment:
/**
 * Brief description of what this function/class does.
 *
 * @param {type} paramName - Parameter description
 * @param {type} anotherParam - Another parameter description
 * @returns {type} Return value description
 * @throws {ErrorType} When error occurs (if applicable)
 */

RULES:
- Output ONLY the JSDoc comment block (/** ... */)
- NO code, NO markdown fences, NO explanations
- Start with /** and end with */
- Include @param for each parameter with type and description
- Include @returns with type and description
- Include @throws if function can throw errors
- Keep descriptions concise but informative
- Infer types from code if not explicitly typed`;
  }

  if (lang === 'python') {
    return `You are a Python docstring generator. Generate PEP 257 docstrings.

OUTPUT FORMAT - Triple-quoted docstring:
"""
Brief description of what this function/class does.

Args:
    param_name: Parameter description
    another_param: Another parameter description

Returns:
    Return value description

Raises:
    ErrorType: When error occurs (if applicable)
"""

RULES:
- Output ONLY the docstring (""" ... """ or ''' ... ''')
- NO code, NO markdown fences, NO explanations
- Use triple double-quotes (""") preferred, or triple single-quotes (''')
- First line: brief summary
- Args section: one line per parameter
- Returns section: description of return value
- Raises section: only if function raises exceptions
- Keep descriptions concise but informative`;
  }

  // Generic fallback for other languages
  return `You are a code documentation generator. Generate appropriate documentation comments for the given code.

RULES:
- Output ONLY the documentation comment (no code)
- Use the standard comment format for ${language}
- NO markdown fences, NO explanations, NO conversational text
- Include parameter descriptions if applicable
- Include return value description if applicable
- Keep descriptions concise but informative`;
}

/**
 * Generates the user prompt for documentation generation.
 *
 * @param code - The code to document
 * @param language - Programming language identifier
 * @returns User prompt string containing the code
 */
export function getDocGenerationUserPrompt(code: string, language: string): string {
  return `Generate documentation for this ${language} code:

${code}

Documentation:`;
}

/**
 * Cleans and validates a documentation response from Claude.
 *
 * Removes markdown fences, conversational text, and validates the format
 * matches the expected documentation style for the language.
 *
 * @param text - Raw documentation response from Claude
 * @param language - Programming language to validate format
 * @returns Cleaned documentation string, or undefined if invalid
 */
export function cleanDocResponse(text: string, language: string): string | undefined {
  const lang = language.toLowerCase();

  // Remove markdown code blocks
  let cleaned = stripMarkdownFences(text).trim();

  // Remove conversational prefixes
  const conversationalPrefixes = [
    /^Here'?s? (the|your) (documentation|docstring|comment)s?:?\s*/i,
    /^I'?ve (generated|created|added) (the|your) (documentation|docstring|comment)s?:?\s*/i,
    /^The (documentation|docstring|comment)s?:?\s*/i,
    /^Sure,?\s*/i,
    /^Certainly,?\s*/i,
  ];

  for (const pattern of conversationalPrefixes) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
    }
  }

  // Validate format based on language
  if (lang === 'typescript' || lang === 'javascript') {
    // Must start with /** and end with */
    if (!cleaned.startsWith('/**')) {
      // Try to find JSDoc block in response
      const match = cleaned.match(/\/\*\*[\s\S]*?\*\//);
      if (match) {
        cleaned = match[0];
      } else {
        log('cleanDocResponse: Invalid JSDoc format - missing /**');
        return undefined;
      }
    }

    if (!cleaned.endsWith('*/')) {
      log('cleanDocResponse: Invalid JSDoc format - missing */');
      return undefined;
    }
  } else if (lang === 'python') {
    // Must start with """ or '''
    if (!cleaned.startsWith('"""') && !cleaned.startsWith("'''")) {
      // Try to find docstring in response
      const match = cleaned.match(/("""[\s\S]*?"""|'''[\s\S]*?''')/);
      if (match) {
        cleaned = match[0];
      } else {
        log('cleanDocResponse: Invalid Python docstring format - missing triple quotes');
        return undefined;
      }
    }

    // Must end with """ or '''
    if (!cleaned.endsWith('"""') && !cleaned.endsWith("'''")) {
      log('cleanDocResponse: Invalid Python docstring format - missing closing triple quotes');
      return undefined;
    }
  }

  // Basic validation: must have some content
  if (cleaned.length < 10) {
    log('cleanDocResponse: Documentation too short');
    return undefined;
  }

  return cleaned;
}

/**
 * Get complexity instruction for error explanations.
 */
function getErrorComplexityInstruction(complexity?: ComplexityLevel): string {
  if (!complexity) return '';

  const instructions: Record<ComplexityLevel, string> = {
    'eli5': 'Explain like I\'m 5 years old - use simple words, analogies, and avoid technical jargon.',
    'curious-amateur': 'Explain for someone learning to code - be clear but can introduce basic technical terms.',
    'imposter-syndrome': 'Explain for an intermediate developer - assume they know fundamentals but might be unfamiliar with this specific issue.',
    'senior': 'Explain for an experienced developer - be concise and technical.',
    'phd': 'Explain with maximum technical depth - include language spec references, compiler internals if relevant.',
  };

  return `\nAUDIENCE: ${COMPLEXITY_LABELS[complexity]} - ${instructions[complexity]}\n`;
}

/**
 * Generates the prompt for error explanation.
 *
 * Requests structured explanation with root cause, why it happens, and how to fix.
 *
 * @param code - The code snippet containing the error
 * @param errorContext - Context about the error (message, code, location, etc.)
 * @param complexity - Optional complexity level for explanation depth
 * @returns Prompt string for error explanation
 */
export function getErrorExplanationPrompt(code: string, errorContext: ErrorContext, complexity?: ComplexityLevel): string {
  const errorType = errorContext.severity === 'error' ? 'Error' : 'Warning';
  const errorCodeInfo = errorContext.errorCode ? ` (Code: ${errorContext.errorCode})` : '';
  const complexityInstruction = getErrorComplexityInstruction(complexity);

  return `You are an expert programming assistant helping debug code.
${complexityInstruction}
Explain this ${errorType.toLowerCase()} in clear, plain text (NO markdown formatting):

${errorType}${errorCodeInfo}: ${errorContext.errorMessage}
Language: ${errorContext.languageId}
File: ${errorContext.fileName}

Code:
${code}

Provide a structured explanation:

ROOT CAUSE:
[What's actually wrong - be specific]

WHY IT HAPPENS:
[Common scenario that leads to this error]

HOW TO FIX:
[Step-by-step fix instructions - plain text only]

IMPORTANT: Output plain text only. No **bold**, *italics*, # headers, - bullets, [links], or code blocks. Just clear paragraphs.`;
}

/**
 * Generates the prompt for error fix generation.
 *
 * Requests only the fixed code without explanations.
 *
 * @param code - The code snippet containing the error
 * @param errorContext - Context about the error (message, code, location, etc.)
 * @returns Prompt string for fix generation
 */
export function getErrorFixPrompt(code: string, errorContext: ErrorContext): string {
  const errorType = errorContext.severity === 'error' ? 'Error' : 'Warning';
  const errorCodeInfo = errorContext.errorCode ? ` (Code: ${errorContext.errorCode})` : '';

  return `You are a code fixing assistant. Fix the following ${errorType.toLowerCase()}.

${errorType}${errorCodeInfo}: ${errorContext.errorMessage}
Language: ${errorContext.languageId}
File: ${errorContext.fileName}

Code to fix:
${code}

REQUIREMENTS:
- Output ONLY the fixed code
- Preserve formatting and indentation
- Make minimal changes (fix the specific error only)
- NO explanations, NO comments, NO markdown
- If unfixable without more context, output: CANNOT_FIX

Fixed code:`;
}

/**
 * Generates the system prompt for inline chat.
 *
 * Instructs Claude to detect whether user is asking a question or requesting
 * a code change, and format the response appropriately.
 *
 * @returns System prompt string for inline chat
 */
export function getInlineChatSystemPrompt(): string {
  return `You are an AI coding assistant integrated into VS Code. The user is asking a question or requesting a code change via inline chat.

RESPONSE FORMAT:
- If the user is asking a QUESTION (what does X do, how do I, explain, why), respond with a clear, concise answer. Start your response with "ANSWER:" followed by your explanation.
- If the user is requesting a CODE CHANGE (add, fix, refactor, convert, modify, implement), respond with the replacement code. Start your response with "CODE:" followed by the code only. Do not include explanations in the code response - just the code that should replace the selection.

GUIDELINES:
- For questions: Be concise but complete. Focus on the specific code context provided.
- For code changes: Return ONLY the code that should replace the selected text. Match the existing code style (indentation, quotes, etc).
- If you cannot determine whether it's a question or code change, treat it as a question.
- Never refuse reasonable requests. If a request is unclear, make a reasonable interpretation.`;
}

/**
 * Generates the user prompt for inline chat.
 *
 * Includes the user query, selected text, and surrounding code context.
 *
 * @param query - User's question or instruction
 * @param selectedText - Currently selected code
 * @param languageId - Programming language identifier
 * @param contextBefore - Code before the selection
 * @param contextAfter - Code after the selection
 * @returns User prompt string for inline chat
 */
export function getInlineChatUserPrompt(
  query: string,
  selectedText: string,
  languageId: string,
  contextBefore: string,
  contextAfter: string
): string {
  const hasSelection = selectedText.trim().length > 0;

  let prompt = `Language: ${languageId}\n\n`;

  if (contextBefore.trim()) {
    prompt += `<context_before language="${languageId}">\n${contextBefore}\n</context_before>\n\n`;
  }

  if (hasSelection) {
    prompt += `<selection language="${languageId}">\n${selectedText}\n</selection>\n\n`;
  }

  if (contextAfter.trim()) {
    prompt += `<context_after language="${languageId}">\n${contextAfter}\n</context_after>\n\n`;
  }

  prompt += `User request: ${query}`;

  return prompt;
}

/**
 * Parses inline chat response to detect mode and extract content.
 *
 * Detects whether response is a question answer or code edit based on prefix.
 *
 * @param response - Raw response text from Claude
 * @returns Parsed result with mode ('question' | 'edit') and content
 */
export function parseInlineChatResponse(response: string): { mode: 'question' | 'edit'; content: string } {
  const trimmed = response.trim();

  if (trimmed.startsWith('CODE:')) {
    // Extract code, removing the CODE: prefix and any surrounding markdown
    let code = trimmed.slice(5).trim();
    // Remove markdown code fences if present
    const codeBlockMatch = code.match(/^```[\w]*\n?([\s\S]*?)\n?```$/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1];
    }
    return { mode: 'edit', content: code };
  }

  if (trimmed.startsWith('ANSWER:')) {
    return { mode: 'question', content: trimmed.slice(7).trim() };
  }

  // Default to question if no prefix detected
  return { mode: 'question', content: trimmed };
}

// ============================================================================
// Pre-commit Review Prompts
// ============================================================================

/**
 * Issue found during pre-commit review.
 */
export interface ReviewIssue {
  /** File path relative to repository root */
  file: string;
  /** Line number (1-indexed) */
  line?: number;
  /** Severity: high, medium, low */
  severity: 'high' | 'medium' | 'low';
  /** Category: logic, security, edge-case, performance */
  category: 'logic' | 'security' | 'edge-case' | 'performance';
  /** Description of the issue */
  message: string;
  /** Suggested fix */
  suggestion?: string;
}

/**
 * Generates the pre-commit review prompt.
 *
 * @param diff - Git diff to review
 * @returns Complete prompt for code review
 */
export function getPreCommitReviewPrompt(diff: string): string {
  return `You are a senior code reviewer analyzing a git diff before commit.

FOCUS AREAS (in priority order):
1. Logic errors: off-by-one, null/undefined handling, race conditions, incorrect operators
2. Security issues: injection risks, auth bypass, data exposure, unsafe deserialization
3. Edge cases: What inputs would break this? Boundary conditions, empty/null cases
4. Performance: N+1 queries, unnecessary loops, memory leaks

DO NOT FLAG:
- Style or formatting issues (leave to linters)
- Missing comments or documentation
- Code that is correct but could be "more elegant"
- Test files or test code

<diff>
${diff}
</diff>

IMPORTANT:
- Only report actual issues - be strict, avoid false positives
- Focus on NEW/CHANGED code (lines starting with +)
- Provide actionable suggestions

OUTPUT FORMAT:
Respond with a JSON array of issues. If no issues found, return empty array [].

[
  {
    "file": "path/to/file.ts",
    "line": 47,
    "severity": "high",
    "category": "logic",
    "message": "Off-by-one error: loop should be i < length, not i <= length",
    "suggestion": "Change loop condition to i < items.length"
  }
]

Return ONLY the JSON array, no other text or markdown.`;
}

/**
 * Parses AI response into structured review issues.
 *
 * @param response - Raw AI response text
 * @returns Array of parsed review issues
 */
export function parseReviewResponse(response: string): ReviewIssue[] {
  try {
    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate it's an array
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate and filter issues
    return parsed.filter((item): item is ReviewIssue => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.file === 'string' &&
        typeof item.message === 'string' &&
        ['high', 'medium', 'low'].includes(item.severity) &&
        ['logic', 'security', 'edge-case', 'performance'].includes(item.category)
      );
    });
  } catch {
    // Failed to parse - return empty array
    return [];
  }
}

// ============================================================================
// PR Description Prompts
// ============================================================================

/**
 * Generates the PR description prompt.
 *
 * @param commits - Array of commit subject lines
 * @param diff - Truncated diff for context
 * @returns Complete prompt for PR description generation
 */
export function getPrDescriptionPrompt(commits: string[], diff: string): string {
  const commitList = commits.map((c, i) => `${i + 1}. ${c}`).join('\n');

  return `You are a technical writer creating a pull request description.

<commits>
${commitList}
</commits>

<diff>
${diff}
</diff>

Generate a GitHub-compatible PR description with these sections:

## Summary
[2-3 sentences: what changed and why, in business/feature terms - not just "updated files"]

## Changes
- [Specific change 1 - what feature/behavior changed]
- [Specific change 2 - what was added/removed/modified]
[Include affected features/components, not just file names]

## Test Plan
- [ ] [How to verify this works - specific steps]
- [ ] [Edge cases to check]

---
Generated with Sidekick

RULES:
- Write for human reviewers (explain WHY, not just what files changed)
- Use past tense ("Added", "Fixed", "Updated")
- Reference ticket/issue numbers if they appear in commit messages
- Keep professional but concise tone
- Output ONLY the Markdown description (no meta-commentary or "Here is the description:")`;
}

/**
 * Cleans and validates PR description response.
 *
 * @param response - Raw AI response
 * @returns Cleaned PR description, or null if invalid
 */
export function cleanPrDescription(response: string): string | null {
  let cleaned = response.trim();

  // Remove common AI preambles
  const preambles = [
    /^here['']?s? (?:the |a |your )?(?:pr |pull request )?description:?\s*/i,
    /^(?:pr |pull request )?description:?\s*/i,
    /^```(?:markdown)?\n?/,
  ];

  for (const preamble of preambles) {
    cleaned = cleaned.replace(preamble, '');
  }

  // Remove trailing code fence if present
  cleaned = cleaned.replace(/\n?```$/, '');

  // Validate: must have ## Summary section
  if (!cleaned.includes('## Summary')) {
    return null;
  }

  // Validate: must have reasonable length
  if (cleaned.length < 50) {
    return null;
  }

  return cleaned.trim();
}
