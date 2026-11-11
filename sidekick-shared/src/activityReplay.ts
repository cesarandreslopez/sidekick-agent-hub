/**
 * Replays a session file through the activity map: the main transcript and,
 * by default, its subagents' transcripts (Claude Code `subagents/` files,
 * Codex child rollouts), merged by time with each child's events attributed
 * to the call that spawned it.
 *
 * Node-only (reads files). The result is the content-free record log, a
 * timeline for scrubbing, and the snapshot and insights at the end.
 *
 * @module activityReplay
 */

import * as fs from 'fs';
import * as path from 'path';
import { createActivityRecorder } from './activity/recorder';
import { summarizeActivity } from './activity/insights';
import { createActivityTimeline, normalizeActivityRecords } from './activity/timeline';
import type {
  ActivityEventSource,
  ActivityInsights,
  ActivityRecord,
  ActivityRecorderOptions,
  ActivitySnapshot,
  ActivityTimeline,
  ActivityTimelineOptions,
} from './activity/types';
import { snapshotActivity } from './activity/state';
import { getClaudeSubagentsDir, parseClaudeSubagentFileName } from './claudePaths';
import { readAgentMeta } from './parsers/subagentScanner';
import type { ProviderId, SessionProviderBase } from './providers/types';
import type { SessionEvent } from './types/sessionEvent';

export interface ReplayActivityOptions
  extends Omit<ActivityRecorderOptions, 'providerId' | 'sessionId'>, ActivityTimelineOptions {
  provider: SessionProviderBase;
  sessionPath: string;
  /** Merge subagent transcripts. Default true. */
  includeSubagents?: boolean;
  /**
   * End calls still open when the log ends (a finished session). Default
   * false: a live session's open calls are really running.
   */
  settle?: boolean;
}

export interface ActivityReplaySubagent {
  agentId: string;
  spawnId?: string;
  /** Events merged in. */
  events: number;
  /** Events dropped because they predate the spawn (history a forked child repeats). */
  dropped: number;
}

export interface ActivityReplay {
  providerId: ProviderId;
  sessionId: string;
  /** Events read, main and subagents. */
  eventCount: number;
  records: ActivityRecord[];
  timeline: ActivityTimeline;
  snapshot: ActivitySnapshot;
  insights: ActivityInsights;
  subagents: ActivityReplaySubagent[];
}

interface Child {
  agentId: string;
  spawnId?: string;
  parentAgentId?: string;
  filePath: string;
}

interface Tagged {
  event: SessionEvent;
  source?: ActivityEventSource;
  time: number;
  order: number;
}

function readEvents(provider: SessionProviderBase, filePath: string): SessionEvent[] {
  try {
    const reader = provider.createReader(filePath, { includeActivitySignals: true });
    const events = reader.readAll();
    reader.flush();
    return events;
  } catch {
    return [];
  }
}

/** Claude Code subagent transcripts beside the session, with the spawning call from each meta file. */
function claudeChildren(sessionPath: string): Child[] {
  const dir = getClaudeSubagentsDir(sessionPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const children: Child[] = [];
  for (const file of files.sort()) {
    const agentId = parseClaudeSubagentFileName(file);
    if (!agentId) continue;
    const filePath = path.join(dir, file);
    const meta = readAgentMeta(filePath);
    children.push({
      agentId,
      filePath,
      ...(meta.toolUseId ? { spawnId: meta.toolUseId } : {}),
      ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId } : {}),
    });
  }
  return children;
}

function providerChildren(provider: SessionProviderBase, sessionPath: string): Child[] {
  try {
    const stats = provider.scanSubagents(
      path.dirname(sessionPath),
      provider.getSessionId(sessionPath),
    );
    return stats
      .filter((stat) => typeof stat.filePath === 'string' && stat.filePath !== sessionPath)
      .map((stat) => ({
        agentId: stat.agentId,
        filePath: stat.filePath as string,
        ...(stat.spawnToolUseId ? { spawnId: stat.spawnToolUseId } : {}),
        ...(stat.parentAgentId ? { parentAgentId: stat.parentAgentId } : {}),
      }));
  } catch {
    return [];
  }
}

/** When each spawning call started, from the events seen so far. */
function spawnTimes(events: readonly SessionEvent[], into: Map<string, number>): void {
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) continue;
    for (const block of content) {
      const typed = block as { type?: unknown; id?: unknown };
      if (
        typed &&
        typed.type === 'tool_use' &&
        typeof typed.id === 'string' &&
        !into.has(typed.id)
      ) {
        into.set(typed.id, time);
      }
    }
  }
}

function tag(
  events: readonly SessionEvent[],
  source: ActivityEventSource | undefined,
  order: { next: number },
): Tagged[] {
  let previous = Number.NEGATIVE_INFINITY;
  return events.map((event) => {
    const parsed = Date.parse(event.timestamp);
    const time = Number.isFinite(parsed) ? parsed : previous;
    previous = time;
    return { event, ...(source ? { source } : {}), time, order: order.next++ };
  });
}

/** Replays a session file (see the module docs). Synchronous, like the readers. */
export function replayActivity(options: ReplayActivityOptions): ActivityReplay {
  const { provider, sessionPath } = options;
  const sessionId = provider.getSessionId(sessionPath);
  const order = { next: 0 };
  const mainEvents = readEvents(provider, sessionPath);
  const tagged: Tagged[] = tag(mainEvents, undefined, order);
  const subagents: ActivityReplaySubagent[] = [];

  if (options.includeSubagents !== false) {
    const children =
      provider.id === 'claude-code'
        ? claudeChildren(sessionPath)
        : providerChildren(provider, sessionPath);
    const spawns = new Map<string, number>();
    spawnTimes(mainEvents, spawns);
    const childEvents = children.map((child) => ({
      child,
      events: readEvents(provider, child.filePath),
    }));
    for (const { events } of childEvents) spawnTimes(events, spawns);
    for (const { child, events } of childEvents) {
      const spawnAt = child.spawnId ? spawns.get(child.spawnId) : undefined;
      const kept =
        spawnAt === undefined
          ? events
          : events.filter((event) => {
              const time = Date.parse(event.timestamp);
              return !Number.isFinite(time) || time >= spawnAt;
            });
      const source: ActivityEventSource = {
        agentId: child.agentId,
        ...(child.spawnId ? { spawnId: child.spawnId } : {}),
        ...(child.parentAgentId ? { parentAgentId: child.parentAgentId } : {}),
      };
      tagged.push(...tag(kept, source, order));
      subagents.push({
        agentId: child.agentId,
        ...(child.spawnId ? { spawnId: child.spawnId } : {}),
        events: kept.length,
        dropped: events.length - kept.length,
      });
    }
  }

  tagged.sort((a, b) => a.time - b.time || a.order - b.order);
  const recorder = createActivityRecorder({
    labels: options.labels,
    stationOverrides: options.stationOverrides,
    memory: options.memory,
    browserServers: options.browserServers,
    deriveContext: options.deriveContext,
    contextWindowOf:
      options.contextWindowOf ??
      (provider.getContextWindowLimit
        ? (model) => provider.getContextWindowLimit?.(model)
        : undefined),
    maxOpenCalls: options.maxOpenCalls,
    providerId: provider.id,
    sessionId,
  });
  const raw: ActivityRecord[] = [];
  for (const item of tagged) raw.push(...recorder.observe(item.event, item.source));
  if (options.settle) {
    const last = tagged.length > 0 ? tagged[tagged.length - 1].time : undefined;
    if (last !== undefined && Number.isFinite(last)) raw.push(...recorder.settle(last));
  }
  const records = normalizeActivityRecords(raw);
  const timeline = createActivityTimeline(records, options);
  const head = timeline.head();
  return {
    providerId: provider.id,
    sessionId,
    eventCount: tagged.length,
    records,
    timeline,
    snapshot: snapshotActivity(head),
    insights: summarizeActivity(head),
    subagents,
  };
}
