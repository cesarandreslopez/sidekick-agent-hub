/**
 * @fileoverview Where a Python docstring goes.
 *
 * A docstring is the first statement of the body, so it goes *after* the
 * signature, indented like the body. Above the `def` it is just an unused
 * string expression (and between a decorator and its `def` it is a
 * SyntaxError).
 *
 * @module utils/pythonDocstring
 */

/** Where to insert a docstring for the definition at a given line. */
export type PythonDocTarget =
  | {
      kind: 'insert';
      /** Line to insert at (may equal the line count when the body is missing). */
      insertLine: number;
      /** Indentation of the body, for every docstring line. */
      indent: string;
      /** The signature line the insertion is anchored to (the `def`/`class` line). */
      defLine: number;
    }
  | { kind: 'documented' }
  | { kind: 'oneLiner' }
  | { kind: 'notDefinition' };

const DEFINITION = /^\s*(async\s+)?(def|class)\b/;
const DOCSTRING_START = /^[rRuUbBfF]{0,2}("""|''')/;

const leadingWhitespace = (line: string) => line.match(/^\s*/)?.[0] ?? '';

/**
 * Finds where the docstring for the definition starting at `startLine` goes.
 *
 * `startLine` may be a decorator; the decorated `def`/`class` is used. The
 * signature ends at the first `:` outside brackets, strings and comments, so
 * type hints, defaults such as `lambda x: x` and dict literals don't end it
 * early.
 */
export function findPythonDocTarget(lines: readonly string[], startLine: number): PythonDocTarget {
  let defLine = startLine;
  while (defLine < lines.length && /^\s*(@|$)/.test(lines[defLine])) defLine++;
  if (defLine >= lines.length || !DEFINITION.test(lines[defLine])) {
    return { kind: 'notDefinition' };
  }

  const end = findSignatureEnd(lines, defLine);
  if (!end) return { kind: 'notDefinition' };

  // Anything but a comment after the colon means the body is on this line.
  const rest = lines[end.line].slice(end.column + 1).trim();
  if (rest && !rest.startsWith('#')) return { kind: 'oneLiner' };

  const defIndent = leadingWhitespace(lines[defLine]);
  let bodyLine = end.line + 1;
  while (bodyLine < lines.length && /^\s*(#.*)?$/.test(lines[bodyLine])) bodyLine++;

  const bodyIndent = bodyLine < lines.length ? leadingWhitespace(lines[bodyLine]) : '';
  const hasBody = bodyLine < lines.length && bodyIndent.length > defIndent.length;
  if (hasBody && DOCSTRING_START.test(lines[bodyLine].trim())) return { kind: 'documented' };

  return {
    kind: 'insert',
    insertLine: end.line + 1,
    indent: hasBody ? bodyIndent : `${defIndent}    `,
    defLine,
  };
}

/** Line and column of the colon that ends the signature starting at `defLine`. */
function findSignatureEnd(
  lines: readonly string[],
  defLine: number,
): { line: number; column: number } | null {
  let depth = 0;
  let quote: string | null = null; // the open string's delimiter: ' " ''' """
  for (let line = defLine; line < lines.length && line < defLine + 200; line++) {
    const text = lines[line];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (text.startsWith(quote, i)) {
          i += quote.length - 1;
          quote = null;
        }
        continue;
      }
      if (ch === '#') break; // comment to end of line
      if (ch === '"' || ch === "'") {
        const triple = ch.repeat(3);
        quote = text.startsWith(triple, i) ? triple : ch;
        i += quote.length - 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === ':' && depth === 0) return { line, column: i };
    }
    // A single-quoted string can't span lines; only triple quotes carry over.
    if (quote && quote.length === 1) quote = null;
  }
  return null;
}
