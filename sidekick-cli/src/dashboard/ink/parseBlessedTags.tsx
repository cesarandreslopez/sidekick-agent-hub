/**
 * Stack-based parser converting blessed tag strings to React/Ink nodes.
 *
 * Supports: {bold}, {underline}, {color-fg}, {color-bg}, {/tag}, nested tags,
 * and the escapes {open} / {close} for literal braces. Any other braced text
 * (`${HOME}`, JSON, `{foo}`) is literal — see blessedText.ts for the pattern.
 * Ignores: {center} (handled at layout level).
 *
 * `{grey-fg}` renders as dim text in the terminal's default colour rather
 * than ANSI bright-black, which is invisible on some themes (Solarized Dark)
 * and low-contrast on light backgrounds.
 */

import React from 'react';
import { Text } from 'ink';
import { tokenizeTagged } from '../blessedText';

interface StyleFrame {
  tag?: string;
  bold?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: string;
  backgroundColor?: string;
}

function isGrey(color: string): boolean {
  return color === 'grey' || color === 'gray';
}

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
  let segKey = 0;

  for (const token of tokenizeTagged(input)) {
    if (token.kind === 'text') {
      segments.push(renderSpan(token.text, currentStyle(styleStack), segKey++));
      continue;
    }

    const tagName = token.name;
    if (token.kind === 'close') {
      let matchingIndex = -1;
      for (let index = styleStack.length - 1; index > 0; index--) {
        if (styleStack[index].tag === tagName) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex > 0) styleStack.splice(matchingIndex);
    } else if (tagName === 'bold') {
      styleStack.push({ ...currentStyle(styleStack), tag: tagName, bold: true });
    } else if (tagName === 'underline') {
      styleStack.push({ ...currentStyle(styleStack), tag: tagName, underline: true });
    } else if (tagName.endsWith('-fg')) {
      const color = tagName.slice(0, -3);
      styleStack.push(
        isGrey(color)
          ? { ...currentStyle(styleStack), tag: tagName, color: undefined, dim: true }
          : { ...currentStyle(styleStack), tag: tagName, color, dim: false },
      );
    } else if (tagName.endsWith('-bg')) {
      const color = tagName.slice(0, -3);
      styleStack.push({
        ...currentStyle(styleStack),
        tag: tagName,
        backgroundColor: isGrey(color) ? 'gray' : color,
      });
    } else {
      // No-op frames keep structural tags ({center}) balanced so their close
      // tags cannot pop an unrelated foreground or emphasis style.
      styleStack.push({ ...currentStyle(styleStack), tag: tagName });
    }
  }

  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0];
  return <>{segments}</>;
}

function currentStyle(stack: StyleFrame[]): StyleFrame {
  return stack[stack.length - 1];
}

function renderSpan(text: string, style: StyleFrame, key: number): React.ReactNode {
  const hasStyle =
    style.bold || style.underline || style.dim || style.color || style.backgroundColor;
  if (!hasStyle) {
    return <Text key={key}>{text}</Text>;
  }
  return (
    <Text
      key={key}
      bold={style.bold}
      underline={style.underline}
      dimColor={style.dim || undefined}
      color={style.color}
      backgroundColor={style.backgroundColor}
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
  return content.split('\n').map((line, i) => <Text key={i}>{parseBlessedTags(line)}</Text>);
}
