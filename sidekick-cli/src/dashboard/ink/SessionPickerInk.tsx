/**
 * Ink-based session picker shown before the dashboard starts.
 * Lists available sessions and lets the user select one.
 * Groups by provider when multiple providers have sessions.
 */

import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { SessionProvider, ProviderId } from 'sidekick-shared';
import { collectSessionItems, collectMultiProviderItems, PROVIDER_BADGES, type SessionPickerItem } from '../SessionPickerHelpers';

/** Provider display names for section headers. */
const PROVIDER_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
  'codex': 'Codex',
};

interface GroupedView {
  /** Flat list of rows: either a header or a selectable item. */
  rows: Array<{ type: 'header'; providerId: string } | { type: 'item'; index: number }>;
  /** Total number of selectable items (items.length + 1 for "wait"). */
  selectableCount: number;
}

/** Build grouped rows when multiple providers have sessions. */
function buildGroupedRows(items: SessionPickerItem[]): GroupedView | null {
  const providerIds = new Set(items.map(it => it.providerId).filter(Boolean));
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

interface SessionPickerInkProps {
  items: SessionPickerItem[];
  onSelect: (sessionPath: string | null) => void;
}

export function SessionPickerInk({ items, onSelect }: SessionPickerInkProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  const grouped = buildGroupedRows(items);
  const totalItems = items.length + 1;

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (input === 'j' || key.downArrow) {
      setSelectedIndex(prev => Math.min(prev + 1, totalItems - 1));
      return;
    }

    if (input === 'k' || key.upArrow) {
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return;
    }

    if (key.return) {
      if (selectedIndex === items.length) {
        onSelect(null);
      } else {
        onSelect(items[selectedIndex].sessionPath);
      }
      return;
    }
  });

  const rows = process.stdout.rows || 24;
  const viewportHeight = Math.max(5, rows - 15);

  /** Render a single session item row. */
  function renderSessionRow(i: number, isSelected: boolean): React.ReactElement {
    if (i === items.length) {
      return (
        <Box key="wait">
          <Text inverse={isSelected}>
            <Text color="yellow">+</Text> Wait for a new session to start...
          </Text>
        </Box>
      );
    }

    const item = items[i];
    const dot = item.isActive ? '\u25CF' : '\u25CB';
    const dotColor = item.isActive ? 'green' : 'gray';
    const badge = item.providerId ? PROVIDER_BADGES[item.providerId] : null;
    const truncLabel = item.label.length > 40
      ? item.label.substring(0, 37) + '...'
      : item.label;

    return (
      <Box key={item.sessionPath}>
        <Text inverse={isSelected}>
          {badge && <Text color={badge.color}>[{badge.badge}]</Text>}{' '}
          <Text color={dotColor}>{dot}</Text> {truncLabel.padEnd(40)}  <Text color="gray">{item.age.padEnd(9)}</Text> <Text color="gray">{item.sessionId}</Text>{item.isActive ? <Text color="green"> LIVE</Text> : ''}
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
      const scrollOffset = Math.max(0, Math.min(selectedVisualPos - Math.floor(viewportHeight / 2), allRows.length - viewportHeight));
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
              <Text dimColor>{'\u2500\u2500'} </Text>
              {badge && <Text color={badge.color}>{name}</Text>}
              {!badge && <Text>{name}</Text>}
              <Text dimColor> {'\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'}</Text>
            </Box>
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
    const scrollOffset = Math.max(0, Math.min(selectedIndex - Math.floor(viewportHeight / 2), totalItems - viewportHeight));
    const visibleStart = Math.max(0, scrollOffset);
    const visibleEnd = Math.min(totalItems, visibleStart + viewportHeight);

    return Array.from({ length: visibleEnd - visibleStart }, (_, vi) => {
      const i = visibleStart + vi;
      return renderSessionRow(i, i === selectedIndex);
    });
  }

  return (
    <Box flexDirection="column" width="100%" height={rows}>
      {/* Logo */}
      <Box justifyContent="center" marginTop={1}>
        <Box flexDirection="column" width={50}>
          <Text bold color="magenta">  S I D E K I C K</Text>
          <Text bold>  Agent Hub</Text>
        </Box>
      </Box>

      {/* Session list */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="magenta"
        marginX={2}
        flexGrow={1}
      >
        <Text color="magenta"> Sessions ({items.length}) </Text>
        {renderList()}
      </Box>

      {/* Status bar */}
      <Box height={1}>
        <Text> <Text bold color="magenta">SIDEKICK</Text> <Text color="gray">Session Picker</Text>  <Text bold>{'\u2191'}/{'\u2193'}</Text> navigate  <Text bold>Enter</Text> select  <Text bold>q</Text> quit</Text>
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
  provider: SessionProvider,
  workspacePath: string,
  additionalProviders?: SessionProvider[],
): Promise<SessionPickerResult> {
  const { render } = await import('ink');

  let items: SessionPickerItem[];
  if (additionalProviders && additionalProviders.length > 0) {
    const allProviders = [provider, ...additionalProviders].map(p => ({ provider: p, workspacePath }));
    items = collectMultiProviderItems(allProviders);
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
          const selected = items.find(it => it.sessionPath === selectedPath);
          resolve({ sessionPath: selectedPath, providerId: selected?.providerId });
        }}
      />,
    );

    instance.waitUntilExit().then(() => {
      reject(new Error('quit'));
    }).catch(reject);
  });
}
