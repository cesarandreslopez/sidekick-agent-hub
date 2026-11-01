/**
 * Feeds Claude Code's subagent meta flags (`finished`, `stoppedByUser` in
 * `agent-<id>.meta.json`) to the dashboard's subagent lifecycles, so a
 * background agent the user stopped from the UI, or one that finished after
 * only an interim notification, settles without a final notification.
 *
 * @module dashboard/subagentEvidence
 */

import * as path from 'path';
import { readAgentMeta, type SubagentStats } from 'sidekick-shared';
import type { DashboardState } from './DashboardState';

/**
 * Reads the meta file next to each scanned Claude Code subagent transcript
 * (`<sessionDir>/<sessionId>/subagents/agent-<id>.meta.json`) and applies its
 * flags. Small JSON reads only; transcripts are not re-read.
 *
 * @returns Whether any lifecycle changed
 */
export function applyClaudeSubagentMeta(
  state: Pick<DashboardState, 'applySubagentEvidence'>,
  sessionPath: string,
  stats: readonly SubagentStats[],
): boolean {
  const sessionId = path.basename(sessionPath, path.extname(sessionPath));
  const subagentsDir = path.join(path.dirname(sessionPath), sessionId, 'subagents');
  let changed = false;
  for (const entry of stats) {
    const meta = readAgentMeta(path.join(subagentsDir, `agent-${entry.agentId}.jsonl`));
    if (meta.finished === undefined && meta.stoppedByUser === undefined) continue;
    const at = entry.endTime ?? new Date();
    changed =
      state.applySubagentEvidence(
        {
          agentId: entry.agentId,
          ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
          ...(meta.finished !== undefined ? { finished: meta.finished } : {}),
          ...(meta.stoppedByUser !== undefined ? { stoppedByUser: meta.stoppedByUser } : {}),
        },
        at.toISOString(),
      ) || changed;
  }
  return changed;
}
