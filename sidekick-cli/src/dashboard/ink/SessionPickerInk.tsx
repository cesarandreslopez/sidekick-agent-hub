/**
 * Ink-based session picker shown before the dashboard starts.
 * Lists available sessions and lets the user select one.
 * Groups by provider when multiple providers have sessions.
 */

import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useStdin } from 'ink';
import type { SessionProviderBase, ProviderId } from 'sidekick-shared';
import {
  collectSessionItems,
  collectMultiProviderItems,
  PROVIDER_BADGES,
  type SessionPickerItem,
} from '../SessionPickerHelpers';
import { BRAND_INLINE, LOGO_ART } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';
import { displayWidth } from '../blessedText';
import { TooSmallOverlay } from './TooSmallOverlay';
import { useTerminalSize } from './useTerminalSize';

/** Cut to `max` terminal columns (wide characters count as two). */
function truncateToWidth(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  for (const ch of Array.from(text)) {
    if (displayWidth(out + ch) > max - 3) break;
    out += ch;
  }
  return out + '...';
}

/** Pad to `width` terminal columns. */
function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Provider display names for section headers. */
const PROVIDER_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

export interface GroupedView {
  /** Flat list of rows: either a header or a selectable item. */
  rows: Array<{ type: 'header'; providerId: string } | { type: 'item'; index: number }>;
  /** Total number of selectable items (items.length + 1 for "wait"). */
  selectableCount: number;
}

/** Build grouped rows when multiple providers have sessions. */
export function buildGroupedRows(items: SessionPickerItem[]): GroupedView | null {
  const providerIds = new Set(items.map((it) => it.providerId).filter(Boolean));
  if (providerIds.size <= 1) return null;

  const rows: GroupedView['rows'] = [];
  const grouped = new Map<string, number[]>();

  for (let i = 0; i < items.length; i++) {
    const pid = items[i].providerId || 'unknown';
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid)!.push(i);
  }

  for (const [pid, indices] of grouped) {
    rows.push({ type: 'header', providerId: pid });
    for (const idx of indices) {
      rows.push({ type: 'item', index: idx });
    }
  }

  // "Wait for new session" is always last selectable item
  rows.push({ type: 'item', index: items.length }); // sentinel for "wait"

  return { rows, selectableCount: items.length + 1 };
}

export function resolvePickerSelection(
  items: SessionPickerItem[],
  grouped: GroupedView | null,
  selectedIndex: number,
): string | null {
  const sourceIndex = grouped
    ? grouped.rows.filter((row) => row.type === 'item')[selectedIndex]?.index
    : selectedIndex;
  if (sourceIndex === undefined || sourceIndex === items.length) return null;
  return items[sourceIndex]?.sessionPath ?? null;
}

interface SessionPickerInkProps {
  items: SessionPickerItem[];
  onSelect: (sessionPath: string | null) => void;
}

/** Smallest terminal the picker lays out in; below it the too-small notice shows. */
const PICKER_MIN_COLUMNS = 60;
const PICKER_MIN_ROWS = 15;
/** The logo costs six rows; below this height they go to the list instead. */
const PICKER_LOGO_MIN_ROWS = 22;
/** Below this width the age and id columns are dropped so titles stay readable. */
const PICKER_DETAIL_MIN_COLUMNS = 70;
const AGE_WIDTH = 9;

export interface PickerLayout {
  tooSmall: boolean;
  showLogo: boolean;
  /** List rows that fit between the chrome. */
  viewportHeight: number;
  /** Whether the age and id columns are shown. */
  showDetails: boolean;
  /** Width of the session title column. */
  labelWidth: number;
  /** Width of the id column (the longest id shown). */
  idWidth: number;
}

/**
 * Lay the picker out for a `columns` × `rows` terminal, from the chrome it
 * actually draws: the logo (one blank row and five lines), the list's border
 * and title row (three), and the status bar (one). The old fixed `rows - 15`
 * left blank rows on tall terminals and overflowed short ones.
 */
export function pickerLayout(
  columns: number,
  rows: number,
  items: readonly SessionPickerItem[],
): PickerLayout {
  const tooSmall = columns < PICKER_MIN_COLUMNS || rows < PICKER_MIN_ROWS;
  const showLogo = rows >= PICKER_LOGO_MIN_ROWS;
  const chrome = (showLogo ? 1 + LOGO_ART.length : 0) + 3 + 1;
  const viewportHeight = Math.max(1, rows - chrome);
  const showDetails = columns >= PICKER_DETAIL_MIN_COLUMNS;
  const idWidth = Math.max(8, ...items.map((item) => displayWidth(item.sessionId)));
  // Margins (2 + 2), border (1 + 1), marker (2), badge (5), dot (2), LIVE (5).
  const fixed = 6 + 2 + 5 + 2 + 5 + (showDetails ? 1 + AGE_WIDTH + 1 + idWidth : 0);
  return {
    tooSmall,
    showLogo,
    viewportHeight,
    showDetails,
    labelWidth: Math.max(10, columns - fixed),
    idWidth,
  };
}

/**
 * The selection change for one keystroke. Ink delivers a run of typed
 * characters as one input (a held `j` arrives as "jjj"), so a run of the same
 * navigation letter moves by its length instead of being ignored.
 */
export function pickerNavigationDelta(
  input: string,
  key: { downArrow?: boolean; upArrow?: boolean },
): number {
  if (key.downArrow) return 1;
  if (key.upArrow) return -1;
  if (/^j+$/.test(input)) return input.length;
  if (/^k+$/.test(input)) return -input.length;
  return 0;
}

export function SessionPickerInk({ items, onSelect }: SessionPickerInkProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const { isRawModeSupported } = useStdin();
  const grouped = buildGroupedRows(items);
  const totalItems = items.length + 1;
  const layout = pickerLayout(columns, rows, items);
  const { viewportHeight } = layout;
  const clamp = (index: number) => Math.max(0, Math.min(totalItems - 1, index));

  useInput(
    (input, key) => {
      if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
        exit();
        return;
      }

      const delta = pickerNavigationDelta(input, key);
      if (delta !== 0) {
        setSelectedIndex((prev) => clamp(prev + delta));
        return;
      }
      if (key.pageDown || key.pageUp) {
        const step = Math.max(1, viewportHeight - 1) * (key.pageDown ? 1 : -1);
        setSelectedIndex((prev) => clamp(prev + step));
        return;
      }
      if (input === 'g' || key.home) {
        setSelectedIndex(0);
        return;
      }
      if (input === 'G' || key.end) {
        setSelectedIndex(totalItems - 1);
        return;
      }

      if (key.return) {
        onSelect(resolvePickerSelection(items, grouped, selectedIndex));
        return;
      }
    },
    { isActive: isRawModeSupported },
  );

  if (layout.tooSmall) return <TooSmallOverlay columns={columns} rows={rows} />;

  /**
   * One row. The selection is marked with a pointer as well as inverse video:
   * NO_COLOR sets chalk to level 0, which drops inverse, and the selected row
   * was then indistinguishable from the others.
   */
  function renderSessionRow(i: number, isSelected: boolean): React.ReactElement {
    const marker = isSelected ? '▸ ' : '  ';
    if (i === items.length) {
      return (
        <Box key="wait">
          <Text inverse={isSelected} wrap="truncate-end">
            {marker}
            <Text color="yellow">+</Text> Wait for a new session to start...
          </Text>
        </Box>
      );
    }

    const item = items[i];
    const dot = item.isActive ? '●' : '○';
    const dotColor = item.isActive ? 'green' : undefined;
    const badge = item.providerId ? PROVIDER_BADGES[item.providerId] : null;
    const truncLabel = padToWidth(
      truncateToWidth(item.label, layout.labelWidth),
      layout.labelWidth,
    );

    return (
      <Box key={item.sessionPath}>
        <Text inverse={isSelected} wrap="truncate-end">
          {marker}
          {badge && <Text color={badge.color}>[{badge.badge}]</Text>}{' '}
          <Text color={dotColor}>{dot}</Text> {truncLabel}
          {layout.showDetails && (
            <>
              {' '}
              <Text dimColor>{item.age.padEnd(AGE_WIDTH)}</Text>{' '}
              <Text dimColor>{padToWidth(item.sessionId, layout.idWidth)}</Text>
            </>
          )}
          {item.isActive ? <Text color="green"> LIVE</Text> : ''}
        </Text>
      </Box>
    );
  }

  /** Render the list content — grouped or flat. */
  function renderList(): React.ReactElement[] {
    if (grouped) {
      // Grouped view: map selectedIndex (selectable-only) to visual rows
      // Build a flat visual list with non-selectable headers
      const allRows = grouped.rows;
      let selectableIdx = 0;

      // Calculate scroll based on selectable index position in visual rows
      const selectablePositions: number[] = [];
      for (let r = 0; r < allRows.length; r++) {
        if (allRows[r].type === 'item') selectablePositions.push(r);
      }
      const selectedVisualPos = selectablePositions[selectedIndex] ?? 0;
      const scrollOffset = Math.max(
        0,
        Math.min(
          selectedVisualPos - Math.floor(viewportHeight / 2),
          allRows.length - viewportHeight,
        ),
      );
      const visibleStart = Math.max(0, scrollOffset);
      const visibleEnd = Math.min(allRows.length, visibleStart + viewportHeight);

      const elements: React.ReactElement[] = [];
      selectableIdx = 0;
      for (let r = 0; r < allRows.length; r++) {
        if (r < visibleStart || r >= visibleEnd) {
          if (allRows[r].type === 'item') selectableIdx++;
          continue;
        }

        const row = allRows[r];
        if (row.type === 'header') {
          const name = PROVIDER_NAMES[row.providerId] || row.providerId;
          const badge = PROVIDER_BADGES[row.providerId as ProviderId];
          elements.push(
            <Box key={`hdr-${row.providerId}`}>
              <Text wrap="truncate-end">
                <Text dimColor>{'──'} </Text>
                {badge ? <Text color={badge.color}>{name}</Text> : name}
                <Text dimColor>
                  {' '}
                  {'──────────'}
                </Text>
              </Text>
            </Box>,
          );
        } else {
          const isSelected = selectableIdx === selectedIndex;
          elements.push(renderSessionRow(row.index, isSelected));
          selectableIdx++;
        }
      }
      return elements;
    }

    // Flat view (single provider or no providers)
    const scrollOffset = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(viewportHeight / 2), totalItems - viewportHeight),
    );
    const visibleStart = Math.max(0, scrollOffset);
    const visibleEnd = Math.min(totalItems, visibleStart + viewportHeight);

    return Array.from({ length: visibleEnd - visibleStart }, (_, vi) => {
      const i = visibleStart + vi;
      return renderSessionRow(i, i === selectedIndex);
    });
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Logo */}
      {layout.showLogo && (
        <Box justifyContent="center" marginTop={1} flexShrink={0}>
          <Box flexDirection="column" width={50}>
            {LOGO_ART.map((line, i) => (
              <Text key={`logo-${i}`} wrap="truncate-end">
                {parseBlessedTags(line)}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Session list */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        marginX={2}
        flexGrow={1}
        overflow="hidden"
      >
        <Text color="magenta" wrap="truncate-end">
          {' '}
          Sessions ({items.length}){' '}
        </Text>
        {renderList()}
      </Box>

      {/* Status bar */}
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {' '}
          {parseBlessedTags(BRAND_INLINE)} <Text dimColor>Session Picker</Text>{' '}
          <Text bold>
            {'↑'}/{'↓'}
          </Text>{' '}
          navigate <Text bold>PgUp/PgDn</Text> page <Text bold>Enter</Text> select{' '}
          <Text bold>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}

export interface SessionPickerResult {
  sessionPath: string | null;
  providerId?: ProviderId;
}

/**
 * Show the session picker and return the selected path + provider.
 * Returns null path for "wait for new session", throws on quit.
 * If additionalProviders are supplied, sessions from all providers are shown.
 */
export async function showSessionPicker(
  provider: SessionProviderBase,
  workspacePath: string,
  additionalProviders?: SessionProviderBase[],
  /** Stream to render into, e.g. the dashboard's alternate-screen stream. */
  options: { stdout?: NodeJS.WriteStream } = {},
): Promise<SessionPickerResult> {
  const { render } = await import('ink');

  let items: SessionPickerItem[];
  if (additionalProviders && additionalProviders.length > 0) {
    items = await collectMultiProviderItems([provider, ...additionalProviders], workspacePath);
  } else {
    const sessions = provider.findAllSessions(workspacePath);
    if (sessions.length === 0) return { sessionPath: null };
    items = collectSessionItems(sessions, provider);
  }

  if (items.length === 0) return { sessionPath: null };

  return new Promise<SessionPickerResult>((resolve, reject) => {
    const instance = render(
      <SessionPickerInk
        items={items}
        onSelect={(selectedPath) => {
          instance.unmount();
          const selected = items.find((it) => it.sessionPath === selectedPath);
          resolve({ sessionPath: selectedPath, providerId: selected?.providerId });
        }}
      />,
      options.stdout ? { stdout: options.stdout } : undefined,
    );

    instance
      .waitUntilExit()
      .then(() => {
        reject(new Error('quit'));
      })
      .catch(reject);
  });
}
