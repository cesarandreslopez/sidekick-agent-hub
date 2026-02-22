/**
 * Stack-based parser converting blessed tag strings to React/Ink nodes.
 *
 * Supports: {bold}, {underline}, {color-fg}, {/tag}, nested tags.
 * Ignores: {center} (handled at layout level).
 */

import React from 'react';
import { Text } from 'ink';

/** Map blessed color names to Ink-compatible color strings. */
function mapColor(c: string): string {
  if (c === 'grey') return 'gray';
  return c;
}

interface StyleFrame {
  bold?: boolean;
  underline?: boolean;
  color?: string;
}

const TAG_RE = /\{(\/?)([^}]+)\}/g;

/**
 * Parse a single line of blessed-tagged text into a React node.
 *
 * Examples:
 *   "{bold}Hello{/bold}" → <Text bold>Hello</Text>
 *   "{red-fg}Error{/red-fg}" → <Text color="red">Error</Text>
 */
export function parseBlessedTags(input: string): React.ReactNode {
  if (!input) return null;

  // Fast path: no tags at all
  if (!input.includes('{')) {
    return input;
  }

  const segments: React.ReactNode[] = [];
  const styleStack: StyleFrame[] = [{}];
  let lastIndex = 0;
  let segKey = 0;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_RE.exec(input)) !== null) {
    const beforeText = input.slice(lastIndex, match.index);
    if (beforeText) {
      segments.push(renderSpan(beforeText, currentStyle(styleStack), segKey++));
    }
    lastIndex = match.index + match[0].length;

    const isClose = match[1] === '/';
    const tagName = match[2];

    if (isClose) {
      // Pop the most recent matching frame
      if (styleStack.length > 1) {
        styleStack.pop();
      }
    } else if (tagName === 'center') {
      // Ignore — handled by layout
    } else if (tagName === 'bold') {
      styleStack.push({ ...currentStyle(styleStack), bold: true });
    } else if (tagName === 'underline') {
      styleStack.push({ ...currentStyle(styleStack), underline: true });
    } else if (tagName.endsWith('-fg')) {
      const color = tagName.slice(0, -3);
      styleStack.push({ ...currentStyle(styleStack), color: mapColor(color) });
    }
    // Other tags (e.g. {white-bg}) are silently ignored
  }

  // Trailing text after last tag
  const trailing = input.slice(lastIndex);
  if (trailing) {
    segments.push(renderSpan(trailing, currentStyle(styleStack), segKey++));
  }

  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0];
  return <>{segments}</>;
}

function currentStyle(stack: StyleFrame[]): StyleFrame {
  return stack[stack.length - 1];
}

function renderSpan(text: string, style: StyleFrame, key: number): React.ReactNode {
  const hasStyle = style.bold || style.underline || style.color;
  if (!hasStyle) {
    return <Text key={key}>{text}</Text>;
  }
  return (
    <Text
      key={key}
      bold={style.bold}
      underline={style.underline}
      color={style.color}
    >
      {text}
    </Text>
  );
}

/**
 * Parse a multi-line blessed-tagged string into an array of React nodes,
 * one per line. Useful for rendering detail pane content.
 */
export function parseBlessedLines(content: string): React.ReactNode[] {
  if (!content) return [];
  return content.split('\n').map((line, i) => (
    <Text key={i}>{parseBlessedTags(line)}</Text>
  ));
}
