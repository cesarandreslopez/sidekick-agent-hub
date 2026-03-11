/**
 * Status bar (bottom row) with segmented zones:
 * Left: brand + version | Center: provider, permission, events | Right: keybinding hints
 */

declare const __CLI_VERSION__: string;

import React from 'react';
import { Box, Text } from 'ink';
import type { UpdateInfo } from '../UpdateCheckService';
import type { ProviderStatusState } from '../ProviderStatusService';
import { BRAND_INLINE } from '../branding';
import { parseBlessedTags } from './parseBlessedTags';

interface StatusBarProps {
  eventCount: number;
  providerName?: string;
  permissionMode?: string | null;
  focusTarget: 'side' | 'detail';
  panelHints: string;
  sessionFilter: string | null;
  filterString: string;
  matchCount?: number;
  totalCount?: number;
  updateInfo?: UpdateInfo | null;
  providerStatus?: ProviderStatusState | null;
}

export function StatusBar({
  eventCount,
  providerName,
  permissionMode,
  focusTarget,
  panelHints,
  sessionFilter,
  filterString,
  matchCount,
  totalCount,
  updateInfo,
  providerStatus,
}: StatusBarProps): React.ReactElement {
  const evtLabel = eventCount > 0 ? `${eventCount} events` : 'waiting...';

  const permissionColor = permissionMode === 'bypassPermissions' ? 'red'
    : permissionMode === 'acceptEdits' ? 'magenta'
    : permissionMode === 'plan' ? 'green'
    : undefined;
  const permissionLabel = permissionMode === 'bypassPermissions' ? 'BYPASS'
    : permissionMode === 'acceptEdits' ? 'EDITS'
    : permissionMode === 'plan' ? 'PLAN'
    : undefined;

  const statusIndicator = providerStatus && providerStatus.indicator !== 'none';
  const statusColor = providerStatus?.indicator === 'minor' ? 'yellow' : 'red';

  return (
    <Box height={1} width="100%">
      {/* Left zone: brand + version */}
      <Box>
        <Text>{parseBlessedTags(BRAND_INLINE)}</Text>
        <Text dimColor> v{__CLI_VERSION__}</Text>
        {updateInfo && (
          <Text color="yellow"> (v{updateInfo.latest})</Text>
        )}
      </Box>

      {/* Center zone: provider, permission, events, status, filters */}
      <Box flexGrow={1} justifyContent="center">
        {providerName && (
          <><Text dimColor> {'\u2502'} </Text><Text color="cyan">{providerName}</Text></>
        )}
        {permissionMode && permissionMode !== 'default' && (
          <><Text dimColor> {'\u2502'} </Text><Text color={permissionColor}>{permissionLabel}</Text></>
        )}
        <Text dimColor> {'\u2502'} </Text>
        <Text>{evtLabel}</Text>
        {statusIndicator && (
          <><Text dimColor> {'\u2502'} </Text><Text color={statusColor}>{'\u25cf'} API {providerStatus!.indicator}</Text></>
        )}
        {filterString && (
          <Text color="yellow">  filter: "{filterString}" ({matchCount ?? 0}/{totalCount ?? 0})</Text>
        )}
        {sessionFilter && (
          <Text color="magenta">  {sessionFilter}</Text>
        )}
      </Box>

      {/* Right zone: keybinding hints */}
      <Box>
        <Text dimColor>{'\u2502'} </Text>
        {focusTarget === 'side' ? (
          <Text>
            <Text bold>{'\u2191\u2193'}</Text><Text dimColor> nav </Text>
            <Text bold>Tab</Text><Text dimColor> detail </Text>
            {panelHints}
            <Text bold>/</Text><Text dimColor> filter </Text>
            <Text bold>?</Text><Text dimColor> help </Text>
            <Text bold>q</Text><Text dimColor> quit</Text>
          </Text>
        ) : (
          <Text>
            <Text bold>j/k</Text><Text dimColor> scroll </Text>
            <Text bold>[]</Text><Text dimColor> tab </Text>
            <Text bold>Tab</Text><Text dimColor> side </Text>
            {panelHints}
            <Text bold>?</Text><Text dimColor> help </Text>
            <Text bold>q</Text><Text dimColor> quit</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
