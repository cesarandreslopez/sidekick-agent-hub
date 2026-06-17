/**
 * Ink-based interactive picker for extracted session assets.
 *
 * Replaces trawl's fzf menu with an in-process TUI. Type to fuzzy-filter, Tab
 * cycles the type filter, Enter acts on the selection (open URLs, copy others),
 * Ctrl-Y copies any selection.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { ExtractedAsset, ExtractedAssetType } from 'sidekick-shared';
import { copyToClipboard } from '../utils/clipboard';
import { openUrl } from '../utils/openUrl';

const TYPE_META: Record<ExtractedAssetType, { tag: string; color: string }> = {
  url: { tag: 'url', color: 'cyan' },
  path: { tag: 'path', color: 'yellow' },
  command: { tag: 'cmd', color: 'green' },
  plan: { tag: 'plan', color: 'magenta' },
};

/** Filter cycle: all → url → path → command → plan → all. */
const FILTER_CYCLE: Array<ExtractedAssetType | 'all'> = ['all', 'url', 'path', 'command', 'plan'];

interface AssetPickerInkProps {
  items: ExtractedAsset[];
  onDone: (action: { kind: 'open' | 'copy' | 'quit'; asset?: ExtractedAsset }) => void;
}

function AssetPickerInk({ items, onDone }: AssetPickerInkProps): React.ReactElement {
  const { exit } = useApp();
  const [query, setQuery] = useState('');
  const [filterIdx, setFilterIdx] = useState(0);
  const [selected, setSelected] = useState(0);

  const typeFilter = FILTER_CYCLE[filterIdx];

  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return items.filter(it => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (!q) return true;
      return (it.display + ' ' + it.text).toLowerCase().includes(q);
    });
  }, [items, query, typeFilter]);

  // Keep selection in range as the filtered list changes.
  const selectedClamped = Math.min(selected, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onDone({ kind: 'quit' });
      exit();
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      setSelected(prev => Math.min(prev + 1, Math.max(0, visible.length - 1)));
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      setSelected(prev => Math.max(prev - 1, 0));
      return;
    }
    if (key.tab) {
      setFilterIdx(prev => (prev + 1) % FILTER_CYCLE.length);
      setSelected(0);
      return;
    }
    if (key.ctrl && input === 'y') {
      const asset = visible[selectedClamped];
      if (asset) { onDone({ kind: 'copy', asset }); exit(); }
      return;
    }
    if (key.return) {
      const asset = visible[selectedClamped];
      if (asset) {
        onDone({ kind: asset.type === 'url' ? 'open' : 'copy', asset });
        exit();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(prev => prev.slice(0, -1));
      setSelected(0);
      return;
    }
    // Printable characters extend the fuzzy query.
    if (input && !key.ctrl && !key.meta) {
      setQuery(prev => prev + input);
      setSelected(0);
    }
  });

  const rows = process.stdout.rows || 24;
  const viewportHeight = Math.max(5, rows - 8);
  const scrollOffset = Math.max(0, Math.min(selectedClamped - Math.floor(viewportHeight / 2), Math.max(0, visible.length - viewportHeight)));
  const windowItems = visible.slice(scrollOffset, scrollOffset + viewportHeight);

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text color="magenta" bold>extract</Text>
        <Text> </Text>
        <Text dimColor>filter:</Text>
        <Text> {typeFilter}</Text>
        <Text dimColor>  query:</Text>
        <Text> {query || ''}</Text>
        <Text inverse>{' '}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
        {visible.length === 0 && <Text dimColor>No matches.</Text>}
        {windowItems.map((item, i) => {
          const realIdx = scrollOffset + i;
          const isSelected = realIdx === selectedClamped;
          const meta = TYPE_META[item.type];
          return (
            <Box key={`${item.type}-${realIdx}`}>
              <Text inverse={isSelected}>
                <Text color={meta.color}>[{meta.tag}]</Text> {item.display}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box height={1}>
        <Text dimColor>
          <Text bold>↑/↓</Text> nav  <Text bold>Tab</Text> filter  <Text bold>Enter</Text> open/copy  <Text bold>^Y</Text> copy  <Text bold>Esc</Text> quit  ({visible.length}/{items.length})
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Render the asset picker and perform the selected action after it closes.
 * Resolves when the user acts or quits.
 */
export async function showAssetPicker(items: ExtractedAsset[]): Promise<void> {
  const { render } = await import('ink');

  const action = await new Promise<{ kind: 'open' | 'copy' | 'quit'; asset?: ExtractedAsset }>((resolve) => {
    let settled = false;
    const finish = (a: { kind: 'open' | 'copy' | 'quit'; asset?: ExtractedAsset }) => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(a);
    };
    const instance = render(<AssetPickerInk items={items} onDone={finish} />);
    instance.waitUntilExit().then(() => finish({ kind: 'quit' })).catch(() => finish({ kind: 'quit' }));
  });

  if (action.kind === 'quit' || !action.asset) return;

  if (action.kind === 'open') {
    const ok = openUrl(action.asset.text);
    process.stdout.write(ok ? `Opened ${action.asset.text}\n` : `Could not open ${action.asset.text}\n`);
  } else {
    const ok = copyToClipboard(action.asset.text);
    process.stdout.write(ok ? 'Copied to clipboard.\n' : 'Could not copy to clipboard.\n');
  }
}
