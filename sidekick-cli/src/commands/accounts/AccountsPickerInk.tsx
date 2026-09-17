/**
 * Full-screen Ink picker for `sidekick accounts`: arrow keys to move, Enter
 * to switch, single letters for the other actions. The picker never performs
 * the action itself — it resolves with the choice so the caller can unmount
 * Ink first (logins and subshells need the raw terminal).
 */

import React, { useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { AccountView } from 'sidekick-shared';
import { PROVIDER_NAMES, accountRowParts, columnWidths, groupByProvider } from './format';

export type PickerActionKind = 'switch' | 'add' | 'login' | 'remove' | 'shell' | 'undo' | 'quit';

export interface PickerAction {
  kind: PickerActionKind;
  account?: AccountView;
}

export type PickerRow =
  | { type: 'header'; providerId: string }
  | { type: 'item'; view: AccountView };

/** Rows in display order: a header per provider, then its accounts. */
export function buildAccountRows(views: AccountView[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const [provider, list] of groupByProvider(views)) {
    rows.push({ type: 'header', providerId: provider });
    for (const view of list) rows.push({ type: 'item', view });
  }
  return rows;
}

/** Selectable accounts in display order (headers skipped). */
export function selectableAccounts(rows: PickerRow[]): AccountView[] {
  return rows
    .filter((row): row is { type: 'item'; view: AccountView } => row.type === 'item')
    .map((row) => row.view);
}

/** Index of the first active account, so Enter defaults to "stay". */
export function initialSelection(views: AccountView[]): number {
  const selectable = selectableAccounts(buildAccountRows(views));
  const index = selectable.findIndex((view) => view.isActive);
  return index >= 0 ? index : 0;
}

interface AccountsPickerInkProps {
  views: AccountView[];
  message?: string | null;
  now?: number;
  onDone: (action: PickerAction) => void;
}

const KEY_HELP: Array<[string, string]> = [
  ['↑↓', 'move'],
  ['Enter', 'switch'],
  ['a', 'add'],
  ['l', 'sign in again'],
  ['r', 'remove'],
  ['s', 'shell'],
  ['u', 'undo'],
  ['?', 'help'],
  ['q', 'quit'],
];

export function AccountsPickerInk({
  views,
  message,
  now,
  onDone,
}: AccountsPickerInkProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [selected, setSelected] = useState(() => initialSelection(views));
  const [showHelp, setShowHelp] = useState(false);
  const rows = buildAccountRows(views);
  const selectable = selectableAccounts(rows);
  const clamped = Math.min(selected, Math.max(0, selectable.length - 1));
  const current = selectable[clamped];
  const widths = columnWidths(views, now);
  const at = now ?? Date.now();

  useInput(
    (input, key) => {
      if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
        onDone({ kind: 'quit' });
        exit();
        return;
      }
      if (input === 'j' || key.downArrow) {
        setSelected((prev) => Math.min(prev + 1, Math.max(0, selectable.length - 1)));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelected((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (input === '?') {
        setShowHelp((prev) => !prev);
        return;
      }
      if (input === 'a') {
        onDone({ kind: 'add' });
        return;
      }
      if (input === 'u') {
        onDone({ kind: 'undo' });
        return;
      }
      if (!current) return;
      if (key.return) {
        onDone({
          kind:
            current.health.state === 'expired' || current.health.state === 'missing'
              ? 'login'
              : 'switch',
          account: current,
        });
        return;
      }
      if (input === 'l') onDone({ kind: 'login', account: current });
      else if (input === 'r') onDone({ kind: 'remove', account: current });
      else if (input === 's') onDone({ kind: 'shell', account: current });
    },
    { isActive: isRawModeSupported },
  );

  const learnedOnly = views.length > 0 && views.every((view) => view.source === 'learned');
  let itemIndex = -1;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="magenta">
          Accounts
        </Text>
        <Text dimColor> {KEY_HELP.map(([k, label]) => `${k} ${label}`).join('  ')}</Text>
      </Box>
      <Text> </Text>
      {views.length === 0 && (
        <Text dimColor>
          No accounts yet. Press a to sign in to one, or sign in with claude / codex and sidekick
          registers it.
        </Text>
      )}
      {rows.map((row) => {
        if (row.type === 'header') {
          return (
            <Text key={`h:${row.providerId}`} bold>
              {PROVIDER_NAMES[row.providerId as keyof typeof PROVIDER_NAMES] ?? row.providerId}
            </Text>
          );
        }
        itemIndex++;
        const isSelected = itemIndex === clamped;
        const p = accountRowParts(row.view, at);
        return (
          <Box key={`${row.view.providerId}:${row.view.id}`}>
            <Text inverse={isSelected}>
              {'  '}
              <Text color="green">{row.view.isActive ? '* ' : '  '}</Text>
              {p.name.padEnd(widths.name)}
              {widths.email ? <Text dimColor> {p.email.padEnd(widths.email)}</Text> : ''}
              {widths.plan ? <Text dimColor> {p.plan.padEnd(widths.plan)}</Text> : ''}
              {'  '}
              <Text color={p.badge.color}>
                {p.badge.glyph} {p.badge.state.padEnd(8)}
              </Text>
              <Text dimColor> {p.badge.detail}</Text>
            </Text>
          </Box>
        );
      })}
      <Text> </Text>
      {message && <Text color="cyan">{message}</Text>}
      {learnedOnly && !message && (
        <Text dimColor>
          Your current logins were registered automatically. Press a to add another.
        </Text>
      )}
      {showHelp && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="magenta"
          paddingX={1}
        >
          <Text bold>Keys</Text>
          <Text>
            Enter switches to the selected account (or signs in again when it has expired).
          </Text>
          <Text>
            a adds another account through an isolated login; l signs the selected one in again.
          </Text>
          <Text>
            s opens a subshell where claude/codex use the selected account without switching.
          </Text>
          <Text>r removes the selected account; u reverts the last switch; q quits.</Text>
        </Box>
      )}
    </Box>
  );
}

export async function showAccountsPicker(
  views: AccountView[],
  options: { message?: string | null; now?: number } = {},
): Promise<PickerAction> {
  const { render } = await import('ink');
  return new Promise<PickerAction>((resolve) => {
    let settled = false;
    const finish = (action: PickerAction): void => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(action);
    };
    const instance = render(
      <AccountsPickerInk
        views={views}
        message={options.message}
        now={options.now}
        onDone={finish}
      />,
    );
    instance
      .waitUntilExit()
      .then(() => finish({ kind: 'quit' }))
      .catch(() => finish({ kind: 'quit' }));
  });
}
