/**
 * The prompt-ordinal scheme: how every reader that publishes or joins on
 * prompt ordinals numbers the human prompts of a session file. Prompt
 * history, session prompt history, usage events' `promptOrdinal`, and tool
 * call origins' `afterOrdinal` all follow it, and a consumer that stores
 * ordinals as keys can compare the version it stored with
 * {@link PROMPT_ORDINAL_SCHEME_VERSION} to know whether they still line up.
 *
 * Scheme 1:
 *
 * - Ordinals are 0-based and per session file, assigned in file order to
 *   each human prompt as defined by `humanPromptText()`. They never depend
 *   on scope, timestamps, `since`, the cursor, or how a file is split across
 *   calls.
 * - A record over 16 MiB (`PROMPT_HISTORY_ORDINAL_MAX_RECORD_BYTES`) and a
 *   line that is not valid JSON are never parsed, so a prompt inside one does
 *   not count and later prompts are not shifted by it.
 * - A prompt whose line has no usable timestamp, or whose working directory
 *   is out of scope, still takes its ordinal; it is only left out of the
 *   results.
 * - Claude Code: a `type: 'user'` record from an interactive entrypoint
 *   (`HUMAN_CLAUDE_ENTRYPOINTS`) that is not meta, sidechain, a compact
 *   summary, a non-human `origin.kind`, or a `promptSource: 'system'`
 *   record, with typed text that is not harness output (interrupt markers,
 *   command output, task notifications, system reminders, the continuation
 *   summary). A slash command counts once, as typed (`/clear`, `/compact`).
 * - Codex: a `response_item` user `message` with typed text after the
 *   injected blocks (`AGENTS.md`, `<environment_context>`, `<turn_aborted>`,
 *   `<subagent_notification>`, image wrappers, …) are dropped. Only a
 *   rollout whose first `session_meta` has an interactive string `source`
 *   (`HUMAN_CODEX_SOURCES`) and no `forked_from_id` has prompts; a subagent,
 *   fork, unknown source, or a prompt before any `session_meta` makes the
 *   whole rollout prompt-free.
 *
 * Any change to these rules bumps the version.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module promptOrdinalScheme
 */

/** The current prompt-ordinal scheme (see the module docs). */
export const PROMPT_ORDINAL_SCHEME_VERSION = 1;
