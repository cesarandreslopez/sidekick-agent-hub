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
  SYNTHETIC_MODEL,
  collectSessionPromptHistory,
  collectUsageEvents,
  formatDurationMs,
  formatTokenCount,
} from 'sidekick-shared';
import type {
  CollectSessionPromptHistoryOptions,
  CollectUsageEventsOptions,
  CostSource,
  PromptHistoryProvider,
  PromptHistorySession,
  PromptHistorySessionPrompt,
  PromptHistorySignal,
  SessionPromptHistoryResult,
  UsageEventRecord,
} from 'sidekick-shared';
import { eventsCostDisplay, formatCostDisplay } from '../costDisplay';
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
    const provider =
      id === 'claude-code'
        ? new ClaudeCodeProvider()
        : new CodexProvider({ includeCompressedRollouts: true });
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

// ── Per-prompt usage ──

/** Tokens and cost of the calls that answered one prompt (or a whole session). */
export interface PromptUsage {
  calls: number;
  /** Cache-inclusive, provider-semantics-aware total. */
  totalTokens: number;
  /** Informational, already inside `totalTokens`. */
  reasoningTokens: number;
  /** Sum of the priced calls; null when none was priced. */
  costUsd: number | null;
  costSource?: CostSource;
  /** Some calls carried tokens but no price: `costUsd` covers the priced ones. */
  partial: boolean;
}

/** One session's usage: per prompt ordinal, plus the whole session. */
export interface SessionPromptUsage {
  total: PromptUsage;
  byOrdinal: Map<number, PromptUsage>;
}

/** Usage events by `(provider, sessionId)`, for `indexPromptUsage`. */
export type PromptUsageIndex = Map<string, SessionPromptUsage>;

function sessionKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function summarizePromptUsage(events: readonly UsageEventRecord[]): PromptUsage {
  const display = eventsCostDisplay(events);
  return {
    calls: events.length,
    totalTokens: events.reduce((sum, event) => sum + event.tokens.totalTokens, 0),
    reasoningTokens: events.reduce((sum, event) => sum + (event.tokens.reasoningTokens ?? 0), 0),
    costUsd: display.cost,
    ...(display.source ? { costSource: display.source } : {}),
    partial: display.partial,
  };
}

/**
 * Group usage events by session and by the prompt they answered. A Claude
 * Code subagent's calls carry their parent session's id and prompt ordinal,
 * so they count toward the prompt that spawned the subagent.
 */
export function indexPromptUsage(events: readonly UsageEventRecord[]): PromptUsageIndex {
  type Group = { all: UsageEventRecord[]; byOrdinal: Map<number, UsageEventRecord[]> };
  const grouped = new Map<string, Group>();
  for (const event of events) {
    if (event.model === SYNTHETIC_MODEL) continue;
    const key = sessionKey(event.provider, event.sessionId);
    const entry: Group = grouped.get(key) ?? { all: [], byOrdinal: new Map() };
    entry.all.push(event);
    if (typeof event.promptOrdinal === 'number') {
      const list = entry.byOrdinal.get(event.promptOrdinal) ?? [];
      list.push(event);
      entry.byOrdinal.set(event.promptOrdinal, list);
    }
    grouped.set(key, entry);
  }
  const index: PromptUsageIndex = new Map();
  for (const [key, entry] of grouped) {
    index.set(key, {
      total: summarizePromptUsage(entry.all),
      byOrdinal: new Map(
        [...entry.byOrdinal].map(([ordinal, list]) => [ordinal, summarizePromptUsage(list)]),
      ),
    });
  }
  return index;
}

export function sessionPromptUsage(
  index: PromptUsageIndex | undefined,
  session: Pick<PromptHistorySession, 'provider' | 'sessionId'>,
): SessionPromptUsage | undefined {
  return index?.get(sessionKey(session.provider, session.sessionId));
}

/** `45.2k tokens · $0.12 (est.)` */
export function formatPromptUsage(usage: PromptUsage): string {
  const cost = formatCostDisplay({
    cost: usage.costUsd,
    source: usage.costSource,
    partial: usage.partial,
  });
  return `${formatTokenCount(usage.totalTokens)} tokens · ${cost}`;
}

/**
 * Bound on reading usage for a dump. A warm usage cache answers in well under
 * a second; a cold one over many sessions can take tens of seconds, and the
 * prompts are the point of the dump, so past this it is skipped with a notice.
 */
export const PROMPT_USAGE_DEADLINE_MS = 30_000;

/**
 * Usage events for the dumped sessions, read through the shared usage
 * collector (and its cache) over the same workspace and time span.
 */
export async function collectPromptUsage(
  sessions: readonly PromptHistorySession[],
  options: {
    workspacePath: string;
    deadlineMs?: number;
    collect?: (options: CollectUsageEventsOptions) => ReturnType<typeof collectUsageEvents>;
  },
): Promise<PromptUsageIndex | { error: string }> {
  if (sessions.length === 0) return new Map();
  const starts = sessions.map((session) => Date.parse(session.startedAt)).filter(Number.isFinite);
  const since = starts.length > 0 ? new Date(Math.min(...starts)) : undefined;
  const wanted = new Set(
    sessions.map((session) => sessionKey(session.provider, session.sessionId)),
  );
  const providers = [...new Set(sessions.map((session) => session.provider))].map((id) =>
    id === 'claude-code'
      ? new ClaudeCodeProvider()
      : new CodexProvider({ includeCompressedRollouts: true }),
  );
  const deadlineMs = options.deadlineMs ?? PROMPT_USAGE_DEADLINE_MS;
  try {
    const collected = await (options.collect ?? collectUsageEvents)({
      providers,
      workspacePaths: [options.workspacePath],
      ...(since ? { since } : {}),
      signal: AbortSignal.timeout(deadlineMs),
    });
    return indexPromptUsage(
      collected.events.filter((event) => wanted.has(sessionKey(event.provider, event.sessionId))),
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      error: timedOut
        ? `Per-prompt usage skipped: reading usage took longer than ${Math.round(deadlineMs / 1000)} s (\`sidekick sessions\` warms the usage cache; --no-usage skips this).`
        : `Per-prompt usage skipped: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    for (const provider of providers) provider.dispose();
  }
}

/** A session for JSON output, with the usage totals this command adds. */
export type PromptSessionWithUsage = PromptHistorySession & {
  /** Every call of the session, subagents included. */
  sessionUsage?: PromptUsage;
  prompts: Array<
    PromptHistorySessionPrompt & {
      /**
       * Every call that answered this prompt, subagents included. (The
       * existing `usage` field is the first answering call only.)
       */
      promptUsage?: PromptUsage;
    }
  >;
};

/** Sessions with `sessionUsage` and per-prompt `promptUsage`, for JSON output. */
export function withPromptUsage(
  sessions: readonly PromptHistorySession[],
  index: PromptUsageIndex | undefined,
): PromptSessionWithUsage[] {
  if (!index) return [...sessions];
  return sessions.map((session) => {
    const usage = sessionPromptUsage(index, session);
    if (!usage) return session;
    return {
      ...session,
      sessionUsage: usage.total,
      prompts: session.prompts.map((prompt) => {
        const promptUsage = usage.byOrdinal.get(prompt.ordinal);
        return promptUsage ? { ...prompt, promptUsage } : prompt;
      }),
    };
  });
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
  options: { width?: number; usage?: PromptUsageIndex } = {},
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
    const usage = sessionPromptUsage(options.usage, session);
    if (usage) details.push(`usage: ${formatPromptUsage(usage.total)}`);
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
      const promptUsage = usage?.byOrdinal.get(prompt.ordinal);
      lines.push(
        `#${prompt.ordinal}  ${formatPromptTime(prompt.timestamp, session.startedAt)}` +
          (promptUsage ? `  ·  ${formatPromptUsage(promptUsage)}` : ''),
      );
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
  usage?: PromptUsage,
): string[] {
  const lines = [
    `### #${prompt.ordinal} · ${formatPromptTime(prompt.timestamp, session.startedAt)}` +
      (usage ? ` · ${formatPromptUsage(usage)}` : ''),
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
export function formatPromptSessionsMarkdown(
  sessions: PromptHistorySession[],
  options: { usage?: PromptUsageIndex } = {},
): string {
  const lines: string[] = ['# Session prompts', ''];
  for (const session of sessions) {
    const bySignal = signalsByPrompt(session);
    const usage = sessionPromptUsage(options.usage, session);
    lines.push(`## ${session.provider} · \`${session.sessionId}\``, '');
    lines.push(`- **Span:** ${sessionSpan(session)}`);
    lines.push(`- **Prompts:** ${session.prompts.length}`);
    if (session.gitBranches.length > 0) {
      lines.push(`- **Branches:** ${session.gitBranches.join(', ')}`);
    }
    if (session.models.length > 0) lines.push(`- **Models:** ${session.models.join(', ')}`);
    if (usage) lines.push(`- **Usage:** ${formatPromptUsage(usage.total)}`);
    const notes = completenessNotes(session);
    lines.push(`- **Complete:** ${notes.length === 0 ? 'yes' : `no (${notes.join(', ')})`}`);
    lines.push('');
    lines.push(...markdownSignals(bySignal.get(-1) ?? [], session));
    for (const prompt of session.prompts) {
      lines.push(
        ...markdownPrompt(
          prompt,
          session,
          bySignal.get(prompt.ordinal) ?? [],
          usage?.byOrdinal.get(prompt.ordinal),
        ),
      );
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
    includeCompressedRollouts: true,
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
  // Tokens and cost per prompt, joined on (provider, session, ordinal).
  // `--no-usage` skips the usage read entirely.
  let usage: PromptUsageIndex | undefined;
  if (opts.usage !== false && result.sessions.length > 0) {
    const collected = await collectPromptUsage(result.sessions, { workspacePath });
    if ('error' in collected) process.stderr.write(`${collected.error}\n`);
    else usage = collected;
  }

  exitQuietlyOnClosedPipe();
  switch (format) {
    case 'json':
      process.stdout.write(
        JSON.stringify({ ...result, sessions: withPromptUsage(result.sessions, usage) }, null, 2) +
          '\n',
      );
      break;
    case 'jsonl':
      process.stdout.write(formatPromptSessionsJsonl(withPromptUsage(result.sessions, usage)));
      break;
    case 'markdown':
      process.stdout.write(formatPromptSessionsMarkdown(result.sessions, { usage }));
      break;
    case 'text':
    default:
      process.stdout.write(
        formatPromptSessionsText(result.sessions, {
          width: opts.width ? parseInt(String(opts.width), 10) : process.stdout.columns || 120,
          usage,
        }),
      );
      break;
  }
}
