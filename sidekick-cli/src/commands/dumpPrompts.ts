/**
 * `sidekick dump --prompts` — every human prompt of a session, grouped by
 * session, for classifying a whole session (intent, conflict, issues).
 *
 * Wraps `collectSessionPromptHistory()`. `--signals` adds interrupts,
 * rejected and failed tool calls, compactions, API errors, and rollbacks;
 * `--replies` adds the agent's last text for each prompt. Claude Code and
 * Codex only; by default both are read, since prompt history spans them.
 */

import {
  ClaudeCodeProvider,
  CodexProvider,
  collectSessionPromptHistory,
  formatDurationMs,
} from 'sidekick-shared';
import type {
  CollectSessionPromptHistoryOptions,
  PromptHistoryProvider,
  PromptHistorySession,
  PromptHistorySessionPrompt,
  PromptHistorySignal,
  SessionPromptHistoryResult,
} from 'sidekick-shared';
import { parseTimeOption } from '../timeRange';
import { parseLimit } from '../utils/parseLimit';

export type PromptDumpFormat = 'text' | 'markdown' | 'json' | 'jsonl';

const PROMPT_DUMP_FORMATS: readonly PromptDumpFormat[] = ['text', 'markdown', 'json', 'jsonl'];

/** Per-call budget for the CLI; a stopped call continues in the drain loop. */
const CLI_DEADLINE_MS = 5 * 60_000;

/** Providers for a prompt dump: both unless one is named. */
export function promptDumpProviders(
  provider: string | undefined,
): PromptHistoryProvider[] | { error: string } {
  if (provider === undefined || provider === 'auto') return ['claude-code', 'codex'];
  if (provider === 'claude-code' || provider === 'codex') return [provider];
  return { error: 'Prompt dumps support claude-code and codex sessions.' };
}

export interface SessionIdCandidate {
  provider: PromptHistoryProvider;
  sessionId: string;
}

/**
 * Resolve `--session` the way `sidekick dump --session` does: an exact id
 * first, then a unique prefix. An id that matches nothing is passed through
 * unchanged, because the collector also covers git worktree siblings.
 */
export function resolvePromptSessionId(
  query: string,
  candidates: SessionIdCandidate[],
): { sessionId: string } | { error: string } {
  const trimmed = query.trim();
  if (!trimmed) return { error: 'no session id given' };
  if (candidates.some((candidate) => candidate.sessionId === trimmed)) {
    return { sessionId: trimmed };
  }
  const matches = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.sessionId.startsWith(trimmed))
        .map((candidate) => candidate.sessionId),
    ),
  ];
  if (matches.length > 1) {
    return { error: `Session ${trimmed} is ambiguous. Matches: ${matches.join(', ')}` };
  }
  return { sessionId: matches[0] ?? trimmed };
}

function listSessionIds(
  providers: PromptHistoryProvider[],
  workspacePath: string,
): SessionIdCandidate[] {
  const candidates: SessionIdCandidate[] = [];
  for (const id of providers) {
    const provider = id === 'claude-code' ? new ClaudeCodeProvider() : new CodexProvider();
    try {
      for (const sessionPath of provider.findAllSessions(workspacePath)) {
        candidates.push({ provider: id, sessionId: provider.getSessionId(sessionPath) });
      }
    } catch {
      // A provider with no session data simply contributes no ids.
    } finally {
      provider.dispose();
    }
  }
  return candidates;
}

/**
 * Call the collector until nothing is left unread or a call makes no
 * progress, then merge the calls into one result.
 */
export async function collectAllPromptSessions(
  options: CollectSessionPromptHistoryOptions,
  collect: typeof collectSessionPromptHistory = collectSessionPromptHistory,
): Promise<SessionPromptHistoryResult> {
  const limit = options.limit ?? Infinity;
  let last = await collect(options);
  const merged: SessionPromptHistoryResult = {
    ...last,
    sessions: [...last.sessions],
    exclusions: [...last.exclusions],
    stats: { ...last.stats },
  };
  const boundsHit = new Set(last.boundsHit);
  while (last.unread.length > 0 && merged.sessions.length < limit) {
    const next = await collect({
      ...options,
      sessionIds: last.unread.map((ref) => ref.sessionId),
      providers: [...new Set(last.unread.map((ref) => ref.provider))],
      limit: Number.isFinite(limit) ? limit - merged.sessions.length : undefined,
    });
    merged.sessions.push(...next.sessions);
    merged.exclusions.push(...next.exclusions);
    for (const bound of next.boundsHit) boundsHit.add(bound);
    for (const key of Object.keys(next.stats) as Array<keyof typeof next.stats>) {
      if (key !== 'sessionsMatched') merged.stats[key] += next.stats[key];
    }
    const progressed = next.sessions.length > 0 || next.unread.length < last.unread.length;
    last = next;
    if (!progressed) break;
  }
  merged.unread = last.unread;
  merged.boundsHit = [...boundsHit];
  merged.sessions.sort(
    (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
  );
  merged.stats.sessionsReturned = merged.sessions.length;
  return merged;
}

// ── Formatting ──

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Local `YYYY-MM-DD HH:MM:SS`, or just the clock when on the same day as `sameDayAs`. */
export function formatPromptTime(iso: string, sameDayAs?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (sameDayAs) {
    const reference = new Date(sameDayAs);
    if (!Number.isNaN(reference.getTime()) && localDay(reference) === localDay(date)) {
      return localClock(date);
    }
  }
  return `${localDay(date)} ${localClock(date)}`;
}

function sessionSpan(session: PromptHistorySession): string {
  const ms = Date.parse(session.lastActivityAt) - Date.parse(session.startedAt);
  const duration = Number.isFinite(ms) && ms > 0 ? ` (${formatDurationMs(ms)})` : '';
  return `${formatPromptTime(session.startedAt)} → ${formatPromptTime(
    session.lastActivityAt,
    session.startedAt,
  )}${duration}`;
}

function completenessNotes(session: PromptHistorySession): string[] {
  const notes: string[] = [];
  if (session.truncated) notes.push('truncated');
  if (session.droppedPrompts > 0) notes.push(`${session.droppedPrompts} prompt(s) out of scope`);
  if (session.excludedRecords > 0) notes.push(`${session.excludedRecords} record(s) unreadable`);
  return notes;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Signals grouped by the prompt they followed (-1: before the first prompt). */
function signalsByPrompt(session: PromptHistorySession): Map<number, PromptHistorySignal[]> {
  const grouped = new Map<number, PromptHistorySignal[]>();
  for (const signal of session.signals ?? []) {
    const list = grouped.get(signal.afterOrdinal) ?? [];
    list.push(signal);
    grouped.set(signal.afterOrdinal, list);
  }
  return grouped;
}

function signalLabel(signal: PromptHistorySignal): string {
  return signal.tool ? `${signal.kind} (${signal.tool})` : signal.kind;
}

function indent(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => (line ? prefix + line : prefix.trimEnd()));
}

/** The first line of `text`, cut to `width`; `…` marks anything left out. */
function firstLine(text: string, width: number): string {
  const [line] = text.split('\n');
  if (line.length > width) return line.slice(0, Math.max(1, width - 1)) + '…';
  return text.includes('\n') ? `${line} …` : line;
}

/** Plain-text report: a header per session, then each prompt in full. */
export function formatPromptSessionsText(
  sessions: PromptHistorySession[],
  options: { width?: number } = {},
): string {
  const width = Math.max(40, options.width ?? 120);
  const rule = '─'.repeat(Math.min(width, 80));
  const lines: string[] = [];

  for (const session of sessions) {
    const bySignal = signalsByPrompt(session);
    const header = [
      session.provider,
      session.sessionId,
      sessionSpan(session),
      plural(session.prompts.length, 'prompt'),
    ];
    if (session.gitBranches.length > 0) header.push(session.gitBranches.join(', '));
    lines.push(rule);
    lines.push(header.join('  ·  '));
    const details: string[] = [];
    if (session.models.length > 0) details.push(`models: ${session.models.join(', ')}`);
    if (session.cwds.length > 0) details.push(`cwd: ${session.cwds.join(', ')}`);
    const notes = completenessNotes(session);
    if (notes.length > 0) details.push(`incomplete: ${notes.join(', ')}`);
    if (details.length > 0) lines.push(details.join('  ·  '));
    lines.push(rule);

    const writeSignals = (ordinal: number): void => {
      for (const signal of bySignal.get(ordinal) ?? []) {
        const head = `    ⚑ ${formatPromptTime(signal.timestamp, session.startedAt)}  ${signalLabel(signal)}`;
        if (!signal.text) {
          lines.push(head);
        } else if (signal.kind === 'toolRejected') {
          lines.push(`${head}:`);
          lines.push(...indent(signal.text, '        '));
        } else {
          lines.push(`${head}: ${firstLine(signal.text, Math.max(20, width - head.length - 2))}`);
        }
      }
    };

    writeSignals(-1);
    for (const prompt of session.prompts) {
      lines.push('');
      lines.push(`#${prompt.ordinal}  ${formatPromptTime(prompt.timestamp, session.startedAt)}`);
      lines.push(...indent(prompt.text, '    '));
      if (prompt.reply) {
        lines.push(`    ↳ reply  ${formatPromptTime(prompt.reply.timestamp, session.startedAt)}`);
        lines.push(...indent(prompt.reply.text, '      '));
      }
      writeSignals(prompt.ordinal);
    }
    lines.push('');
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** A fence longer than any backtick run in `text`, so the text cannot close it. */
function fenced(text: string, indentBy = ''): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${indentBy}${fence}text`, ...indent(text, indentBy), `${indentBy}${fence}`];
}

function markdownPrompt(
  prompt: PromptHistorySessionPrompt,
  session: PromptHistorySession,
  signals: PromptHistorySignal[],
): string[] {
  const lines = [
    `### #${prompt.ordinal} · ${formatPromptTime(prompt.timestamp, session.startedAt)}`,
    '',
  ];
  lines.push(...fenced(prompt.text), '');
  if (prompt.reply) {
    lines.push(`**Reply** (${formatPromptTime(prompt.reply.timestamp, session.startedAt)})`, '');
    lines.push(...fenced(prompt.reply.text), '');
  }
  lines.push(...markdownSignals(signals, session));
  return lines;
}

function markdownSignals(signals: PromptHistorySignal[], session: PromptHistorySession): string[] {
  if (signals.length === 0) return [];
  const lines: string[] = [];
  for (const signal of signals) {
    lines.push(
      `- ${formatPromptTime(signal.timestamp, session.startedAt)} **${signal.kind}**${
        signal.tool ? ` (\`${signal.tool}\`)` : ''
      }${signal.textTruncated ? ' _(text truncated)_' : ''}`,
    );
    if (signal.text) lines.push('', ...fenced(signal.text, '  '), '');
  }
  lines.push('');
  return lines;
}

/** Markdown report: one section per session, prompts and replies fenced verbatim. */
export function formatPromptSessionsMarkdown(sessions: PromptHistorySession[]): string {
  const lines: string[] = ['# Session prompts', ''];
  for (const session of sessions) {
    const bySignal = signalsByPrompt(session);
    lines.push(`## ${session.provider} · \`${session.sessionId}\``, '');
    lines.push(`- **Span:** ${sessionSpan(session)}`);
    lines.push(`- **Prompts:** ${session.prompts.length}`);
    if (session.gitBranches.length > 0) {
      lines.push(`- **Branches:** ${session.gitBranches.join(', ')}`);
    }
    if (session.models.length > 0) lines.push(`- **Models:** ${session.models.join(', ')}`);
    const notes = completenessNotes(session);
    lines.push(`- **Complete:** ${notes.length === 0 ? 'yes' : `no (${notes.join(', ')})`}`);
    lines.push('');
    lines.push(...markdownSignals(bySignal.get(-1) ?? [], session));
    for (const prompt of session.prompts) {
      lines.push(...markdownPrompt(prompt, session, bySignal.get(prompt.ordinal) ?? []));
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** One session per line, for pipelines that classify sessions one at a time. */
export function formatPromptSessionsJsonl(sessions: PromptHistorySession[]): string {
  return sessions.map((session) => JSON.stringify(session) + '\n').join('');
}

/** Human-readable notices for stderr: bounds, unread sessions, truncation. */
export function promptDumpNotices(result: SessionPromptHistoryResult): string[] {
  const notices: string[] = [];
  if (result.unread.length > 0) {
    const bounds = result.boundsHit.filter((bound) => bound !== 'maxSessionBytes');
    const reason = bounds.length > 0 ? bounds.join(', ') : 'changed while reading';
    notices.push(
      `${plural(result.unread.length, 'session')} not read (${reason}): ${result.unread
        .map((ref) => ref.sessionId)
        .join(', ')}`,
    );
  }
  for (const session of result.sessions) {
    if (session.truncated) {
      notices.push(`Session ${session.sessionId} was truncated; later prompts are missing.`);
    }
  }
  return notices;
}

export function parsePromptDumpFormat(
  format: string | undefined,
  json: boolean,
): PromptDumpFormat | { error: string } {
  if (json) return 'json';
  const value = (format ?? 'text') as PromptDumpFormat;
  return PROMPT_DUMP_FORMATS.includes(value)
    ? value
    : { error: `Unknown format "${format}". Use one of: ${PROMPT_DUMP_FORMATS.join(', ')}.` };
}

/** A reader that stops early (`| head`) ends the dump quietly, as Unix filters do. */
function exitQuietlyOnClosedPipe(): void {
  process.stdout.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

function fail(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

export async function dumpPromptsAction(
  opts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const workspacePath = (globalOpts.project as string | undefined) || process.cwd();
  const providers = promptDumpProviders(globalOpts.provider as string | undefined);
  if ('error' in providers) return fail(providers.error);
  const format = parsePromptDumpFormat(opts.format as string | undefined, !!globalOpts.json);
  if (typeof format === 'object') return fail(format.error);
  if (opts.session && opts.all) return fail('--session and --all cannot be combined.');

  let limit: number | undefined;
  let since: Date | undefined;
  try {
    limit = parseLimit(opts.limit as string | undefined);
    since = opts.since ? parseTimeOption(String(opts.since)) : undefined;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const options: CollectSessionPromptHistoryOptions = {
    workspacePaths: [workspacePath],
    providers,
    include: { signals: !!opts.signals, replies: !!opts.replies },
    bounds: { deadlineMs: CLI_DEADLINE_MS },
    ...(since ? { since } : {}),
  };
  if (opts.session) {
    const resolved = resolvePromptSessionId(
      String(opts.session),
      listSessionIds(providers, workspacePath),
    );
    if ('error' in resolved) return fail(resolved.error);
    options.sessionIds = [resolved.sessionId];
  } else if (!opts.all) {
    // Like `sidekick dump`: the most recent session unless more are asked for.
    options.limit = limit ?? 1;
  } else if (limit !== undefined) {
    options.limit = limit;
  }

  const result = await collectAllPromptSessions(options);
  for (const notice of promptDumpNotices(result)) process.stderr.write(`${notice}\n`);

  if (result.sessions.length === 0 && format !== 'json') {
    if (opts.session)
      return fail(`Session ${String(opts.session)} has no prompts in this project.`);
    process.stderr.write('No sessions with prompts found for this project.\n');
    return;
  }
  exitQuietlyOnClosedPipe();
  switch (format) {
    case 'json':
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    case 'jsonl':
      process.stdout.write(formatPromptSessionsJsonl(result.sessions));
      break;
    case 'markdown':
      process.stdout.write(formatPromptSessionsMarkdown(result.sessions));
      break;
    case 'text':
    default:
      process.stdout.write(
        formatPromptSessionsText(result.sessions, {
          width: opts.width ? parseInt(String(opts.width), 10) : process.stdout.columns || 120,
        }),
      );
      break;
  }
}
