/**
 * `sidekick-shared/headless` — parsers for the machine-readable output of
 * agents run without a UI: `claude -p --output-format stream-json` and
 * `codex exec --json`. Each turns a process's stdout, fed in chunks of any
 * size, into one event vocabulary (session, text, tool, usage, result,
 * error, compaction, hook, status), with usage in disjoint buckets and a
 * `result` of `incomplete` when the stream ends without a terminal event.
 *
 * Pure and dependency-free: `TextDecoder` only, no filesystem, no Zod, so it
 * fits bundles that spawn agents. Everything here is also exported from the
 * package root.
 *
 * @module headless
 */

export {
  createClaudeStreamJsonParser,
  parseClaudeStreamMessage,
} from './headless/claudeStreamJson';
export { createCodexExecJsonParser, parseCodexExecEvent } from './headless/codexExecJson';
export { DEFAULT_HEADLESS_MAX_LINE_BYTES } from './headless/lineSplitter';
export type {
  HeadlessCompactionEvent,
  HeadlessErrorEvent,
  HeadlessEvent,
  HeadlessHookEvent,
  HeadlessParseOptions,
  HeadlessProvider,
  HeadlessResultEvent,
  HeadlessSessionEvent,
  HeadlessStatusEvent,
  HeadlessStreamOptions,
  HeadlessStreamParser,
  HeadlessStreamState,
  HeadlessTextEvent,
  HeadlessTokenUsage,
  HeadlessToolEvent,
  HeadlessToolStatus,
  HeadlessUnknownEvent,
  HeadlessUsageEvent,
} from './headless/types';
