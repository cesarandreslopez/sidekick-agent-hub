/**
 * Which station a tool call belongs to and what to call it, for Claude Code,
 * Codex and OpenCode tool names.
 *
 * Pure.
 *
 * @module activity/classify
 */

import type { ActivityClassification, ActivityClassifyOptions } from './types';

export function classifyActivityTool(
  _name: string,
  _input: Readonly<Record<string, unknown>> | undefined,
  _options?: ActivityClassifyOptions,
): ActivityClassification {
  throw new Error('activity/classify: not implemented');
}

export function classifyActivityShell(
  _command: string | readonly string[],
  _options?: ActivityClassifyOptions,
): Pick<ActivityClassification, 'station' | 'label' | 'labelKey' | 'hint'> {
  throw new Error('activity/classify: not implemented');
}
