/**
 * Ink picker for extracted session assets.
 *
 * Inspired by `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { ExtractedAsset, ExtractedAssetType } from 'sidekick-shared';
import { copyToClipboard } from '../utils/clipboard';
import { openUrl } from '../utils/openUrl';

const TYPE_META: Record<ExtractedAssetType, { tag: string; color: string }> = {
  url: { tag: 'url', color: 'cyan' },
  path: { tag: 'path', color: 'yellow' },
  command: { tag: 'cmd', color: 'green' },
  plan: { tag: 'plan', color: 'magenta' },
};

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
    const normalizedQuery = query.toLowerCase();
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!normalizedQuery) return true;
      return `${item.display} ${item.text}`.toLowerCase().includes(normalizedQuery);
    });
  }, [items, query, typeFilter]);

  const selectedClamped = Math.min(selected, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onDone({ kind: 'quit' });
      exit();
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      setSelected((prev) => Math.min(prev + 1, Math.max(0, visible.length - 1)));
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      setSelected((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (key.tab) {
      setFilterIdx((prev) => (prev + 1) % FILTER_CYCLE.length);
      setSelected(0);
      return;
    }
    if (key.ctrl && input === 'y') {
      const asset = visible[selectedClamped];
      if (asset) {
        onDone({ kind: 'copy', asset });
        exit();
      }
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
      setQuery((prev) => prev.slice(0, -1));
      setSelected(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
      setSelected(0);
    }
  });

  const rows = process.stdout.rows || 24;
  const viewportHeight = Math.max(5, rows - 8);
  const scrollOffset = Math.max(
    0,
    Math.min(selectedClamped - Math.floor(viewportHeight / 2), Math.max(0, visible.length - viewportHeight)),
  );
  const windowItems = visible.slice(scrollOffset, scrollOffset + viewportHeight);

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text color="magenta" bold>extract</Text>
        <Text> </Text>
        <Text dimColor>filter:</Text>
        <Text> {typeFilter}</Text>
        <Text dimColor>  query:</Text>
        <Text> {query}</Text>
        <Text inverse>{' '}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
        {visible.length === 0 && <Text dimColor>No matches.</Text>}
        {windowItems.map((item, index) => {
          const realIndex = scrollOffset + index;
          const isSelected = realIndex === selectedClamped;
          const meta = TYPE_META[item.type];
          return (
            <Box key={`${item.type}-${realIndex}`}>
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

export async function showAssetPicker(items: ExtractedAsset[]): Promise<void> {
  const { render } = await import('ink');

  const action = await new Promise<{ kind: 'open' | 'copy' | 'quit'; asset?: ExtractedAsset }>((resolve) => {
    let settled = false;
    const finish = (nextAction: { kind: 'open' | 'copy' | 'quit'; asset?: ExtractedAsset }) => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(nextAction);
    };
    const instance = render(<AssetPickerInk items={items} onDone={finish} />);
    instance.waitUntilExit().then(() => finish({ kind: 'quit' })).catch(() => finish({ kind: 'quit' }));
  });

  if (action.kind === 'quit' || !action.asset) return;

  if (action.kind === 'open') {
    const opened = openUrl(action.asset.text);
    process.stdout.write(opened ? `Opened ${action.asset.text}\n` : `Could not open ${action.asset.text}\n`);
  } else {
    const copied = copyToClipboard(action.asset.text);
    process.stdout.write(copied ? 'Copied to clipboard.\n' : 'Could not copy to clipboard.\n');
  }
}
