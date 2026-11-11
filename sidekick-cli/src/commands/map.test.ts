import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityExportSchema, ClaudeCodeProvider } from 'sidekick-shared';

const FIXTURE = path.resolve(
  __dirname,
  '../../../sidekick-shared/src/fixtures/activity/claude-code/sess-activity.jsonl',
);

const mocks = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('../cli', () => ({ resolveProvider: () => mocks.provider }));
import { followConflicts, mapAction, momentOf } from './map';

class FixtureProvider extends ClaudeCodeProvider {
  override findAllSessions(): string[] {
    return [FIXTURE];
  }
}

function command(opts: Record<string, unknown>, globals: Record<string, unknown> = {}): Command {
  return {
    parent: { opts: () => ({ project: '/work/demo', ...globals }) },
    opts: () => opts,
  } as unknown as Command;
}

let stdout: string[];
let stderr: string[];
let scratch: string;

beforeEach(() => {
  mocks.provider = new FixtureProvider();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-map-command-'));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('followConflicts', () => {
  it('names the export options that make no sense live', () => {
    expect(followConflicts({ follow: false, format: 'svg' })).toEqual([]);
    expect(followConflicts({ follow: true })).toEqual([]);
    expect(followConflicts({ follow: true, format: 'svg', at: '50%', output: 'x' })).toEqual([
      '--format',
      '--at',
      '--output',
    ]);
  });
});

describe('sidekick map', () => {
  it('prints the text map, the feed and the insights', async () => {
    await mapAction({}, command({ width: '90', height: '20' }));
    const text = stdout.join('');
    expect(process.exitCode).toBeUndefined();
    expect(text).toContain('CLAUDE');
    expect(text).toContain('── Activity');
    expect(text).toContain('── Insights');
  });

  it('shows the agent’s descriptions in local text, and names only with --labels names', async () => {
    // The fixture puts a canary in a subagent's description: descriptive
    // labels (the text default) may show it; names-only labels never do.
    await mapAction({}, command({ width: '90', height: '20' }));
    expect(stdout.join('')).toContain('Background SKCANARY');
    stdout.length = 0;
    await mapAction({}, command({ width: '90', height: '20', labels: 'names' }));
    expect(stdout.join('')).not.toContain('SKCANARY');
  });

  it('writes a well-formed SVG with no animation by default', async () => {
    const file = path.join(scratch, 'map.svg');
    await mapAction({}, command({ format: 'svg', output: file }));
    const svg = fs.readFileSync(file, 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<animate');
    expect(svg).not.toContain('SKCANARY');
    expect(stderr.join('')).toContain(`Activity map written to: ${file}`);
    expect(stdout).toEqual([]);
  });

  it('prints JSON that validates against the wire schema, with names-only labels', async () => {
    await mapAction({}, command({ format: 'json' }));
    const parsed = activityExportSchema.safeParse(JSON.parse(stdout.join('')));
    expect(parsed.success).toBe(true);
    expect(stdout.join('')).not.toContain('SKCANARY');
  });

  it('uses JSON for the global --json flag', async () => {
    await mapAction({}, command({}, { json: true }));
    expect(JSON.parse(stdout.join('')).kind).toBe('sidekick-activity');
  });

  it('shows an earlier moment with --at and clamps outside the session', async () => {
    await mapAction({}, command({ format: 'json', at: 'start' }));
    const early = JSON.parse(stdout.join(''));
    stdout.length = 0;
    await mapAction({}, command({ format: 'json' }));
    const end = JSON.parse(stdout.join(''));
    expect(early.at).toBeLessThan(end.at);
    expect(early.snapshot.totals.calls).toBeLessThan(end.snapshot.totals.calls);

    stdout.length = 0;
    await mapAction({}, command({ format: 'json', at: '+10h' }));
    expect(stderr.join('')).toContain('outside the session');
  });

  it('rejects a malformed --at and an export option combined with --follow', async () => {
    await mapAction({}, command({ at: '15m' }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('+15m');

    process.exitCode = undefined;
    stderr.length = 0;
    await mapAction({}, command({ follow: true, format: 'svg' }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('--follow cannot be combined with --format');
  });

  it('needs an interactive terminal to follow', async () => {
    const stdin = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await mapAction({}, command({ follow: true }));
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    }
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('sidekick map --follow needs an interactive terminal');
  });

  it('reports a missing session', async () => {
    class EmptyProvider extends ClaudeCodeProvider {
      override findAllSessions(): string[] {
        return [];
      }
    }
    mocks.provider = new EmptyProvider();
    await mapAction({}, command({}));
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('No sessions found');
  });
});

describe('momentOf', () => {
  it('returns the end unchanged without a spec', () => {
    const snapshot = { at: 10, startedAt: 0 } as never;
    const insights = {} as never;
    const timeline = { startAt: 0, endAt: 10 } as never;
    expect(momentOf({ snapshot, insights, timeline }, null)).toEqual({
      at: 10,
      snapshot,
      insights,
      clamped: false,
    });
  });
});
