/**
 * Pure utility functions for HTML report generation.
 * No external dependencies — regex-based markdown and syntax highlighting.
 */

// Re-export formatting helpers from sessionDump
export { fmtTokens, fmtCost, formatTimestamp, formatDuration } from '../formatters/sessionDump';

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lightweight markdown-to-HTML converter.
 * Covers: headings, bold, italic, code blocks, inline code, lists, links, blockquotes.
 */
export function simpleMarkdownToHtml(text: string): string {
  // First, extract and replace fenced code blocks to protect them from other transformations
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const highlighted = highlightCodeBlock(code.trimEnd(), lang);
    codeBlocks.push(
      `<div class="code-block-wrapper"><pre class="code-block" data-lang="${escapeHtml(lang || 'text')}"><code>${highlighted}</code></pre>` +
      `<button class="copy-btn" onclick="copyCode(this)" title="Copy">Copy</button></div>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Escape HTML in remaining content
  result = escapeHtml(result);

  // Headings (must be at line start)
  result = result.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  result = result.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  result = result.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  result = result.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  result = result.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Bold and italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code (after escaping so backtick content is already safe)
  result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists
  result = result.replace(/^(\s*)[-*] (.+)$/gm, '$1<li>$2</li>');

  // Ordered lists
  result = result.replace(/^(\s*)\d+\. (.+)$/gm, '$1<li>$2</li>');

  // Wrap consecutive <li> elements in <ul>
  result = result.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Horizontal rules
  result = result.replace(/^---+$/gm, '<hr>');

  // Paragraphs: convert double newlines to paragraph breaks
  result = result.replace(/\n\n+/g, '</p><p>');
  result = `<p>${result}</p>`;

  // Clean up empty paragraphs
  result = result.replace(/<p>\s*<\/p>/g, '');

  // Single newlines to <br> within paragraphs (but not before block elements)
  result = result.replace(/(?<!<\/(?:h[1-4]|ul|li|blockquote|hr|div|pre)>)\n(?!<(?:h[1-4]|ul|li|blockquote|hr|div|pre|p|\/))/g, '<br>\n');

  // Restore code blocks
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx, 10)]);

  return result;
}

// Keyword sets for syntax highlighting
const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'this', 'class', 'extends', 'super',
  'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw',
  'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
  'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum', 'implements',
  'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'as',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from',
  'as', 'try', 'except', 'finally', 'raise', 'with', 'yield', 'lambda', 'pass',
  'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False',
  'self', 'async', 'await', 'global', 'nonlocal', 'del', 'assert',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'function', 'return', 'exit', 'echo', 'export', 'source', 'local', 'readonly',
  'set', 'unset', 'shift', 'cd', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'grep',
  'sed', 'awk', 'find', 'xargs', 'chmod', 'chown', 'sudo', 'apt', 'npm', 'git',
]);

/**
 * Minimal keyword-based syntax highlighting.
 * Returns HTML with <span class="hl-*"> wrappers.
 * Input should NOT be HTML-escaped (this function escapes it).
 */
export function highlightCodeBlock(code: string, lang: string): string {
  const escaped = escapeHtml(code);

  if (lang === 'json') {
    return highlightJson(escaped);
  }

  const keywords = getKeywordSet(lang);
  if (!keywords) return escaped;

  return highlightWithKeywords(escaped, keywords, lang);
}

function getKeywordSet(lang: string): Set<string> | null {
  switch (lang.toLowerCase()) {
    case 'js':
    case 'javascript':
    case 'ts':
    case 'typescript':
    case 'tsx':
    case 'jsx':
      return JS_KEYWORDS;
    case 'python':
    case 'py':
      return PYTHON_KEYWORDS;
    case 'bash':
    case 'sh':
    case 'shell':
    case 'zsh':
      return BASH_KEYWORDS;
    default:
      return null;
  }
}

function highlightWithKeywords(escaped: string, keywords: Set<string>, lang: string): string {
  // Highlight strings
  let result = escaped.replace(/(&#39;(?:[^&#]|&(?!#39;))*&#39;|&quot;(?:[^&]|&(?!quot;))*&quot;)/g,
    '<span class="hl-string">$1</span>');

  // Highlight comments
  if (lang === 'python' || lang === 'py' || lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') {
    result = result.replace(/(#[^\n]*)/g, '<span class="hl-comment">$1</span>');
  } else {
    result = result.replace(/(\/\/[^\n]*)/g, '<span class="hl-comment">$1</span>');
  }

  // Highlight keywords (word boundaries)
  result = result.replace(/\b(\w+)\b/g, (match, word: string) => {
    if (keywords.has(word)) {
      return `<span class="hl-keyword">${word}</span>`;
    }
    // Numbers
    if (/^\d+(\.\d+)?$/.test(word)) {
      return `<span class="hl-number">${word}</span>`;
    }
    return match;
  });

  return result;
}

function highlightJson(escaped: string): string {
  // Highlight keys
  let result = escaped.replace(/(&quot;)([^&]*?)(&quot;)\s*:/g,
    '<span class="hl-key">$1$2$3</span>:');

  // Highlight string values
  result = result.replace(/:\s*(&quot;)([^&]*?)(&quot;)/g,
    ': <span class="hl-string">$1$2$3</span>');

  // Highlight numbers, booleans, null
  result = result.replace(/:\s*(\d+(\.\d+)?)/g, ': <span class="hl-number">$1</span>');
  result = result.replace(/:\s*(true|false|null)\b/g, ': <span class="hl-keyword">$1</span>');

  return result;
}
