/**
 * Every word the activity map shows on its own (station names and the fixed
 * label vocabulary). Hosts may override any of them; records carry a
 * `labelKey` for vocabulary labels so a renderer can show them in another
 * language without the record changing.
 *
 * Pure: constants only.
 *
 * @module activity/strings
 */

import type { ActivityStationId } from './stations';

export const ACTIVITY_LABEL_KEYS = [
  'newMessage',
  'answerReady',
  'turnInterrupted',
  'turnFailed',
  'notification',
  'webSearch',
  'questionForYou',
  'fileForYou',
  'subagent',
  'skill',
  'loadingTools',
  'todoList',
  'planMode',
  'planUpdate',
  'compacting',
  'stdin',
  'hookCheck',
  'hookContext',
  'hookBlocked',
  'hookError',
  'instructions',
  'memory',
  'command',
  'read',
  'edit',
  'search',
  'fetch',
  'mcpCall',
  'tool',
  'modelStep',
  'modelSwitch',
] as const;

export type ActivityLabelKey = (typeof ACTIVITY_LABEL_KEYS)[number];

export interface ActivityStrings {
  /** Accessible name of the map. */
  title: string;
  stations: Record<ActivityStationId, string>;
  labels: Record<ActivityLabelKey, string>;
  /** Shown when nothing is running. */
  idle: string;
  /** Shown while the model works with no tool call open. */
  thinking: string;
  /** Word before the context percentage. */
  context: string;
  /** Duration placeholder for an entry still running. */
  running: string;
  /** Feed placeholder before anything happened. */
  nothingYet: string;
  /** Suffix for "and N more" running calls. */
  andMore: (n: number) => string;
  /** Pattern descriptions. */
  retryStreak: (station: string, failures: number) => string;
  alternation: (a: string, b: string, cycles: number) => string;
  editTestLoop: (cycles: number) => string;
}

export const DEFAULT_ACTIVITY_STRINGS: ActivityStrings = {
  title: 'Activity map',
  stations: {
    you: 'You',
    model: 'Model',
    memory: 'Memory',
    files: 'Files',
    shell: 'Shell',
    network: 'Network',
    browser: 'Browser',
    agents: 'Agents',
    skills: 'Skills',
    hooks: 'Hooks',
    plan: 'Plan',
  },
  labels: {
    newMessage: 'new message',
    answerReady: 'answer ready',
    turnInterrupted: 'turn interrupted',
    turnFailed: 'turn failed',
    notification: 'notification',
    webSearch: 'web search',
    questionForYou: 'question for you',
    fileForYou: 'file for you',
    subagent: 'subagent',
    skill: 'skill',
    loadingTools: 'loading tools',
    todoList: 'todo list',
    planMode: 'plan mode',
    planUpdate: 'plan update',
    compacting: 'compacting context',
    stdin: 'input to a running command',
    hookCheck: 'hook check',
    hookContext: 'hook added context',
    hookBlocked: 'hook blocked a call',
    hookError: 'hook failed',
    instructions: 'instructions',
    memory: 'memory',
    command: 'command',
    read: 'read',
    edit: 'edit',
    search: 'search',
    fetch: 'fetch',
    mcpCall: 'mcp call',
    tool: 'tool',
    modelStep: 'model step',
    modelSwitch: 'model switch',
  },
  idle: 'Nothing is running.',
  thinking: 'thinking',
  context: 'context',
  running: 'running',
  nothingYet: 'Nothing yet.',
  andMore: (n) => ` and ${n} more`,
  retryStreak: (station, failures) => `${station} failed ${failures}× in a row`,
  alternation: (a, b, cycles) => `${a} ↔ ${b} ×${cycles}`,
  editTestLoop: (cycles) => `edit ↔ test loop ×${cycles}`,
};

/** Overrides merged over the defaults, one level deep for the two tables. */
export function resolveActivityStrings(overrides?: Partial<ActivityStrings>): ActivityStrings {
  if (!overrides) return DEFAULT_ACTIVITY_STRINGS;
  return {
    ...DEFAULT_ACTIVITY_STRINGS,
    ...overrides,
    stations: { ...DEFAULT_ACTIVITY_STRINGS.stations, ...overrides.stations },
    labels: { ...DEFAULT_ACTIVITY_STRINGS.labels, ...overrides.labels },
  };
}
