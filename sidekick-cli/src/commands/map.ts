/**
 * `sidekick map` — the activity map of a session: where its work went,
 * station by station (files, shell, network, memory, agents, …).
 *
 * Without `--follow` it replays a session and prints the map as text, an SVG
 * or JSON, at its end or at any moment (`--at`). With `--follow` it opens a
 * live full-screen map of the running session, for a terminal split beside
 * the agent.
 */

import * as fs from 'fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  exportActivity,
  renderActivityMapSvg,
  replayActivity,
  resolveSessionPath,
  summarizeActivity,
} from 'sidekick-shared';
import type {
  ActivityInsights,
  ActivityLabelMode,
  ActivityMotion,
  ActivitySnapshot,
  ActivityTheme,
} from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { parseAtSpec, resolveAt } from '../activity/atSpec';
import type { AtSpec } from '../activity/atSpec';
import { buildTextReport } from '../activity/frame';
import { rowsToAnsi } from '../activity/tones';
import type { ChalkLike } from '../activity/tones';
import { readActivityMapConfig } from '../utils/cliConfig';
import { checkInteractivePreflight, currentTerminalCapabilities } from './interactivePreflight';

export type MapFormat = 'text' | 'svg' | 'json';

export interface MapFlags {
  follow: boolean;
  format?: MapFormat;
  at?: string;
  output?: string;
}

/** Options that make no sense with `--follow`, by flag name; empty when the combination is valid. */
export function followConflicts(flags: MapFlags): string[] {
  if (!flags.follow) return [];
  const conflicts: string[] = [];
  if (flags.format) conflicts.push('--format');
  if (flags.at) conflicts.push('--at');
  if (flags.output) conflicts.push('--output');
  return conflicts;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** The snapshot and insights at the resolved moment of a replay. */
export function momentOf(
  replay: Pick<ReturnType<typeof replayActivity>, 'snapshot' | 'insights' | 'timeline'>,
  spec: AtSpec | null,
): { at: number; snapshot: ActivitySnapshot; insights: ActivityInsights; clamped: boolean } {
  const end = replay.timeline.endAt ?? replay.snapshot.at;
  const start = replay.timeline.startAt ?? replay.snapshot.startedAt ?? end;
  if (!spec || !Number.isFinite(end)) {
    return { at: end, snapshot: replay.snapshot, insights: replay.insights, clamped: false };
  }
  const { at, clamped } = resolveAt(spec, { startMs: start, endMs: end });
  if (at >= end) return { at: end, snapshot: replay.snapshot, insights: replay.insights, clamped };
  const state = replay.timeline.stateAt(at);
  return {
    at,
    snapshot: replay.timeline.snapshotAt(at),
    insights: summarizeActivity(state),
    clamped,
  };
}

export async function mapAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const flags: MapFlags = {
    follow: Boolean(opts.follow),
    ...(opts.format ? { format: opts.format as MapFormat } : {}),
    ...(opts.at ? { at: String(opts.at) } : {}),
    ...(opts.output ? { output: String(opts.output) } : {}),
  };

  const conflicts = followConflicts(flags);
  if (conflicts.length > 0) {
    fail(
      `--follow cannot be combined with ${conflicts.join(', ')}; drop --follow to export a snapshot.`,
    );
    return;
  }

  const config = readActivityMapConfig();
  const coreName = (opts.coreName as string | undefined) ?? config.coreName;
  const workspacePath: string = globalOpts.project || process.cwd();

  if (flags.follow) {
    const preflight = checkInteractivePreflight(
      currentTerminalCapabilities(),
      'map --follow',
      'sidekick map --format text',
    );
    if (preflight) {
      process.stderr.write(preflight.message);
      process.exitCode = preflight.exitCode;
      return;
    }
    const provider = resolveProvider(globalOpts);
    const { runMapFollow } = await import('../activity/follow');
    await runMapFollow({
      provider,
      workspacePath,
      ...(opts.session ? { sessionId: String(opts.session) } : {}),
      recorder: {
        ...config.recorder,
        labels:
          (opts.labels as ActivityLabelMode | undefined) ?? config.recorder.labels ?? 'descriptive',
      },
      ...(coreName ? { coreName } : {}),
    });
    return;
  }

  let spec: AtSpec | null = null;
  if (flags.at) {
    try {
      spec = parseAtSpec(flags.at);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
  }

  const format: MapFormat = flags.format ?? (globalOpts.json ? 'json' : 'text');
  // Text stays on this machine, so it may show the model's short descriptions;
  // files (SVG, JSON) get names only unless asked otherwise.
  const labels: ActivityLabelMode =
    (opts.labels as ActivityLabelMode | undefined) ??
    config.recorder.labels ??
    (format === 'text' ? 'descriptive' : 'names');

  const provider = resolveProvider(globalOpts);
  try {
    let sessionPath: string;
    try {
      sessionPath = resolveSessionPath(provider, workspacePath, opts.session as string | undefined);
    } catch (error) {
      fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const replay = replayActivity({
      provider,
      sessionPath,
      includeSubagents: Boolean(opts.subagents),
      ...config.recorder,
      labels,
    });
    const moment = momentOf(replay, spec);
    if (moment.clamped) {
      process.stderr.write(`--at ${flags.at} is outside the session; showing its nearest end.\n`);
    }

    let body: string;
    if (format === 'svg') {
      const theme = ((opts.theme as string | undefined) ?? 'auto') as ActivityTheme;
      body = renderActivityMapSvg(moment.snapshot, {
        now: moment.at,
        theme,
        motion: ((opts.motion as string | undefined) ?? 'none') as ActivityMotion,
        insights: moment.insights,
        ...(coreName ? { coreName } : {}),
      });
    } else if (format === 'json') {
      body = JSON.stringify(
        exportActivity({
          snapshot: moment.snapshot,
          insights: moment.insights,
          providerId: replay.providerId,
          sessionId: replay.sessionId,
          at: moment.at,
        }),
        null,
        2,
      );
    } else {
      const columns = positiveInt(opts.width) ?? (process.stdout.columns || 100);
      const rows =
        positiveInt(opts.height) ?? (process.stdout.isTTY ? (process.stdout.rows || 40) - 14 : 24);
      const lines = rowsToAnsi(
        buildTextReport({
          snapshot: moment.snapshot,
          insights: moment.insights,
          now: moment.at,
          width: columns,
          mapHeight: Math.max(15, rows),
          ...(coreName ? { coreName } : {}),
        }),
        chalk as unknown as ChalkLike,
      );
      body = lines.join('\n');
    }

    if (flags.output) {
      fs.writeFileSync(flags.output, `${body}\n`, 'utf-8');
      process.stderr.write(`Activity map written to: ${flags.output}\n`);
    } else {
      process.stdout.write(`${body}\n`);
    }
  } finally {
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
  }
}
