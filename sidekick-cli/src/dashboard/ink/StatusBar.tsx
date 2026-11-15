import { presentProviderStatus } from '../providerStatusPresentation';
/**
 * Status bar (bottom row) with segmented zones:
 * Left: brand + version | Center: provider, permission, events, badges | Right: key hints
 *
 * What fits is decided up front by `planStatusBar` against the terminal
 * width, so the row never wraps: the brand and `? help  q quit` always show,
 * and lower-priority segments drop out first on narrow terminals.
 */

declare const __CLI_VERSION__: string;

import React from 'react';
import { Box, Text } from 'ink';
import type { UpdateInfo } from '../../updateCheck';
import type { ProviderStatusState } from '../ProviderStatusService';
import { BRAND_NAME } from '../branding';
import type { StatusBadge } from './dataStatus';
import {
  CENTER_SEPARATOR,
  HINT_GAP,
  RIGHT_PREFIX,
  clipLabel,
  planStatusBar,
  type StatusPiece,
  type StatusSegment,
} from './statusBarPlan';

export interface StatusHint {
  key: string;
  label: string;
}

interface StatusBarProps {
  /** Terminal width the bar must fit in. */
  columns: number;
  eventCount: number;
  providerName?: string;
  permissionMode?: string | null;
  focusTarget: 'side' | 'detail';
  /** Hints for the active panel's own keys. */
  panelHints: StatusHint[];
  sessionFilter: string | null;
  filterString: string;
  matchCount?: number;
  totalCount?: number;
  updateInfo?: UpdateInfo | null;
  providerStatus?: ProviderStatusState | null;
  openaiStatus?: ProviderStatusState | null;
  mouseEnabled?: boolean;
  /** Data-source health badge, or null when everything is healthy and fresh. */
  dataBadge?: StatusBadge | null;
  /** Active account of the monitored provider, coloured by credential health. */
  activeAccount?: {
    label: string;
    color: 'green' | 'yellow' | 'red' | 'gray';
    /** Credential state shown as text when it is not fresh (colour is not enough). */
    state?: string;
  } | null;
  /** The followed session is pinned (no auto-switch to newer sessions). */
  isPinned?: boolean;
  /** A newer session is waiting; `s` switches to it. */
  hasPendingSession?: boolean;
}

const PERMISSION_STYLES: Record<string, { label: string; color: string }> = {
  bypassPermissions: { label: 'BYPASS', color: 'red' },
  acceptEdits: { label: 'EDITS', color: 'magenta' },
  plan: { label: 'PLAN', color: 'green' },
  auto: { label: 'AUTO', color: 'yellow' },
  dontAsk: { label: 'DONT-ASK', color: 'blue' },
};

function hintSegment(hint: StatusHint, priority: number, id: string): StatusSegment {
  return {
    id,
    zone: 'right',
    priority,
    pieces: [{ text: hint.key, bold: true }, { text: ` ${hint.label}`, dim: true }],
  };
}

export function buildStatusSegments(props: StatusBarProps): StatusSegment[] {
  const segments: StatusSegment[] = [];
  const left = (id: string, priority: number, pieces: StatusPiece[]) =>
    segments.push({ id, zone: 'left', priority, pieces });
  const center = (id: string, priority: number, pieces: StatusPiece[]) =>
    segments.push({ id, zone: 'center', priority, pieces });

  left('brand', 0, [{ text: BRAND_NAME, bold: true, color: 'magenta' }]);
  left('version', 8, [{ text: ` v${__CLI_VERSION__}`, dim: true }]);
  if (props.updateInfo) {
    left('update', 8, [{ text: ` (v${props.updateInfo.latest})`, color: 'yellow' }]);
  }

  if (props.providerName) center('provider', 2, [{ text: props.providerName, color: 'cyan' }]);
  if (props.activeAccount) {
    const { label, color, state } = props.activeAccount;
    const suffix = state && state !== 'fresh' ? ` (${state})` : '';
    center('account', 4, [
      { text: `⎔ ${clipLabel(label, 16)}${suffix}`, color: color === 'gray' ? undefined : color },
    ]);
  }
  if (props.permissionMode && props.permissionMode !== 'default') {
    const style = PERMISSION_STYLES[props.permissionMode] ?? {
      label: props.permissionMode.toUpperCase(),
      color: undefined,
    };
    center('permission', 3, [{ text: style.label, color: style.color }]);
  }
  center('events', 1, [
    { text: props.eventCount > 0 ? `${props.eventCount} events` : 'waiting…' },
  ]);
  if (props.hasPendingSession) {
    center('pending', 1, [
      { text: 's', bold: true, color: 'yellow' },
      { text: ' new session', color: 'yellow' },
    ]);
  }
  if (props.isPinned) center('pinned', 2, [{ text: 'PINNED', color: 'yellow' }]);

  for (const [id, status] of [
    ['claude-status', props.providerStatus],
    ['openai-status', props.openaiStatus],
  ] as const) {
    if (!status) continue;
    const display = presentProviderStatus(status);
    if (display.visible) center(id, 5, [{ text: display.summary, color: display.color }]);
  }
  if (props.mouseEnabled === false) center('mouse', 5, [{ text: 'MOUSE OFF', color: 'yellow' }]);
  if (props.dataBadge) {
    center('data', 3, [{ text: props.dataBadge.text, color: props.dataBadge.color }]);
  }
  if (props.filterString) {
    center('filter', 2, [
      {
        text: `filter: "${clipLabel(props.filterString, 16)}" (${props.matchCount ?? 0}/${props.totalCount ?? 0})`,
        color: 'yellow',
      },
    ]);
  }
  if (props.sessionFilter) {
    center('session-filter', 3, [{ text: props.sessionFilter, color: 'magenta' }]);
  }

  const nav: StatusHint[] =
    props.focusTarget === 'side'
      ? [
          { key: '↑↓', label: 'nav' },
          { key: 'Tab', label: 'detail' },
        ]
      : [
          { key: 'j/k', label: 'scroll' },
          { key: '[]', label: 'tab' },
          { key: 'Tab', label: 'side' },
        ];
  nav.forEach((hint, i) => segments.push(hintSegment(hint, 7, `nav-${i}`)));
  props.panelHints.forEach((hint, i) => segments.push(hintSegment(hint, 6, `panel-${i}`)));
  if (props.focusTarget === 'side') {
    segments.push(hintSegment({ key: '/', label: 'filter' }, 7, 'filter-hint'));
  }
  segments.push(hintSegment({ key: '?', label: 'help' }, 0, 'help'));
  segments.push(hintSegment({ key: 'q', label: 'quit' }, 0, 'quit'));
  return segments;
}

function renderPieces(pieces: StatusPiece[]): React.ReactNode {
  return pieces.map((piece, i) => (
    <Text key={i} bold={piece.bold} color={piece.color} dimColor={piece.dim}>
      {piece.text}
    </Text>
  ));
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const plan = planStatusBar(buildStatusSegments(props), props.columns);
  const leftSegs = plan.filter((s) => s.zone === 'left');
  const centerSegs = plan.filter((s) => s.zone === 'center');
  const rightSegs = plan.filter((s) => s.zone === 'right');

  return (
    <Box height={1} width={props.columns} overflow="hidden">
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          {leftSegs.map((segment) => (
            <React.Fragment key={segment.id}>{renderPieces(segment.pieces)}</React.Fragment>
          ))}
        </Text>
      </Box>

      <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="center" overflow="hidden">
        <Text wrap="truncate-end">
          {centerSegs.map((segment) => (
            <React.Fragment key={segment.id}>
              <Text dimColor>{CENTER_SEPARATOR}</Text>
              {renderPieces(segment.pieces)}
            </React.Fragment>
          ))}
        </Text>
      </Box>

      {rightSegs.length > 0 && (
        <Box flexShrink={0}>
          <Text wrap="truncate-end">
            <Text dimColor>{RIGHT_PREFIX}</Text>
            {rightSegs.map((segment, i) => (
              <React.Fragment key={segment.id}>
                {i > 0 ? HINT_GAP : ''}
                {renderPieces(segment.pieces)}
              </React.Fragment>
            ))}
          </Text>
        </Box>
      )}
    </Box>
  );
}
