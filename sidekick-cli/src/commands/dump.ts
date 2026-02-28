/**
 * `sidekick dump` — Dump session data as text timeline, JSON metrics, or markdown report.
 *
 * Reads a full session JSONL file, processes all events through EventAggregator,
 * and outputs in the requested format.
 */

import * as path from 'path';
import type { Command } from 'commander';
import {
  EventAggregator,
  createWatcher,
  formatSessionText,
  formatSessionMarkdown,
  formatSessionJson,
} from 'sidekick-shared';
import type { FollowEvent } from 'sidekick-shared';
import { resolveProvider } from '../cli';

type OutputFormat = 'text' | 'json' | 'markdown';

export async function dumpAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();
  const sessionId: string | undefined = opts.session;
  const format: OutputFormat = (opts.format as OutputFormat) || 'text';
  const termWidth: number = opts.width ? parseInt(opts.width as string, 10) : (process.stdout.columns || 120);
  const expand: boolean = !!opts.expand;

  // Collect all events by replaying through the watcher
  const events: FollowEvent[] = [];
  let sessionPath: string;

  try {
    try {
      const result = createWatcher({
        provider,
        workspacePath,
        sessionId,
        callbacks: {
          onEvent: (event: FollowEvent) => {
            events.push(event);
          },
          onError: (_err: Error) => { /* ignore */ },
        },
      });
      sessionPath = result.sessionPath;

      // Synchronous replay of all existing events
      result.watcher.start(true);
      result.watcher.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exit(1);
    }

    // Process all events through the aggregator
    const aggregator = new EventAggregator({ providerId: provider.id as 'claude-code' | 'opencode' | 'codex' });
    for (const event of events) {
      aggregator.processFollowEvent(event);
    }

    const metrics = aggregator.getMetrics();
    const sessionFileName = path.basename(sessionPath);

    switch (format) {
      case 'json':
        process.stdout.write(formatSessionJson(metrics));
        break;
      case 'markdown':
        process.stdout.write(formatSessionMarkdown(metrics, { expand, sessionFileName }));
        break;
      case 'text':
      default:
        process.stdout.write(formatSessionText(metrics, { width: termWidth, expand }));
        break;
    }
  } finally {
    try { provider.dispose(); } catch { /* ignore */ }
  }
}
