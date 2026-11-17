/**
 * Changelog overlay showing version info and recent changes, centered over the dashboard.
 *
 * Every content row is cut to the box's inner width, and the visible-row
 * budget counts the overlay's own frame and footer plus the status bar, so
 * the title and the close hint stay on screen at 80×24.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ChangelogEntry } from 'sidekick-shared';
import { useTerminalSize } from './useTerminalSize';
import { displayWidth } from '../blessedText';
import { changelogItemRows } from './changelogText';

declare const __CLI_VERSION__: string;

const CHANGELOG_URL = 'https://cesarandreslopez.github.io/sidekick-agent-hub/changelog/';
/** Below this many rows the changelog URL block is dropped to keep entries visible. */
const URL_MIN_ROWS = 20;

interface ChangelogOverlayProps {
  entries: ChangelogEntry[];
  scrollOffset: number;
  /** Report the real max scroll offset so state can be clamped to content. */
  onClampScroll?: (maxOffset: number) => void;
  /** Terminal rows taken by chrome outside the overlay (the status bar). */
  reservedRows?: number;
}

export function ChangelogOverlay({
  entries,
  scrollOffset,
  onClampScroll,
  reservedRows = 1,
}: ChangelogOverlayProps): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const width = Math.max(24, Math.min(96, columns - 2));
  const inner = width - 4; // single border (2) + paddingX (2)
  const showUrl = rows >= URL_MIN_ROWS;
  const urlRows = showUrl ? Math.ceil(displayWidth(CHANGELOG_URL) / inner) : 0;

  // Chrome: border 2 + paddingY 2 + title 1 + spacer 1 + scroll indicators 2
  // + spacer 1 + close hint 1, plus the URL block when shown.
  const chrome = 10 + (showUrl ? 2 + urlRows : 0);
  const maxVisibleLines = Math.max(1, rows - reservedRows - chrome);

  // Build all content lines
  const lines: React.ReactElement[] = [];

  // Version header
  const latestDate = entries[0]?.date || '';
  lines.push(
    <Text key="ver" wrap="truncate-end">
      {'  '}
      <Text bold color="cyan">
        Terminal Dashboard v{__CLI_VERSION__}
      </Text>
      {latestDate ? (
        <Text dimColor>
          {' — '}
          {latestDate}
        </Text>
      ) : null}
    </Text>,
  );
  lines.push(<Text key="sep"> </Text>);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Version heading (skip for first entry since it's in the header)
    if (i > 0) {
      lines.push(
        <Text key={`v-${i}`} wrap="truncate-end">
          {'  '}
          <Text bold>v{entry.version}</Text>
          <Text dimColor>
            {' — '}
            {entry.date}
          </Text>
        </Text>,
      );
    }
    for (const section of entry.sections) {
      lines.push(
        <Text key={`h-${i}-${section.heading}`} wrap="truncate-end">
          {'  '}
          <Text bold color="yellow">
            {section.heading}
          </Text>
        </Text>,
      );
      for (let j = 0; j < section.items.length; j++) {
        // Wrapped with a hanging indent, markdown rendered: each item used
        // to be cut to one line with its ** and backticks showing.
        changelogItemRows(section.items[j], inner).forEach((row, r) => {
          const indent = row.level === 0 ? '    ' : '      ';
          const glyph = row.level === 0 ? '•' : '◦';
          lines.push(
            <Text key={`item-${i}-${section.heading}-${j}-${r}`} wrap="truncate-end">
              {indent}
              {row.first ? <Text dimColor>{glyph}</Text> : ' '}{' '}
              {row.segments.map((segment, k) => (
                <Text key={k} bold={segment.bold}>
                  {segment.text}
                </Text>
              ))}
            </Text>,
          );
        });
      }
    }
    if (i < entries.length - 1) {
      lines.push(<Text key={`gap-${i}`}> </Text>);
    }
  }

  // Apply scroll offset, clamped to content so over-scrolling never blanks
  // the box or freezes later scroll-ups (the reducer counter is unbounded).
  const maxOffset = Math.max(0, lines.length - maxVisibleLines);
  React.useEffect(() => {
    if (scrollOffset > maxOffset) onClampScroll?.(maxOffset);
  }, [scrollOffset, maxOffset, onClampScroll]);
  const offset = Math.min(scrollOffset, maxOffset);
  const visibleLines = lines.slice(offset, offset + maxVisibleLines);
  const canScrollUp = offset > 0;
  const canScrollDown = offset + maxVisibleLines < lines.length;

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        paddingX={1}
        paddingY={1}
        width={width}
        flexShrink={0}
      >
        <Text wrap="truncate-end">
          {' '}
          <Text bold color="magenta">
            {'⚡'} W H A T ' S N E W
          </Text>
        </Text>
        <Text> </Text>

        {/* Scroll indicators keep their rows so the frame never jumps. */}
        <Text dimColor wrap="truncate-end">
          {canScrollUp ? '  ▲ scroll up (k)' : ' '}
        </Text>

        {visibleLines}

        <Text dimColor wrap="truncate-end">
          {canScrollDown ? '  ▼ scroll down (j)' : ' '}
        </Text>

        {showUrl && (
          <>
            <Text> </Text>
            <Text dimColor wrap="truncate-end">
              {' '}
              Full changelog:
            </Text>
            {/* The URL wraps rather than truncates; its rows are in the budget. */}
            <Text color="cyan">{CHANGELOG_URL}</Text>
          </>
        )}
        <Text> </Text>
        <Text dimColor wrap="truncate-end">
          {' '}
          Press <Text bold>Esc</Text> or <Text bold>V</Text> to close
        </Text>
      </Box>
    </Box>
  );
}
