/**
 * `sidekick report` — Generate a self-contained HTML session report and open in browser.
 *
 * Reads a full session JSONL file, processes events for stats via EventAggregator,
 * parses the raw transcript for full content, and generates a branded HTML report.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import {
  EventAggregator,
  createWatcher,
  generateHtmlReport,
  parseTranscript,
  parseTranscriptFromEvents,
  openInBrowser,
} from 'sidekick-shared';
import type { FollowEvent, HtmlReportOptions } from 'sidekick-shared';
import { resolveProvider } from '../cli';

export function resolveReportFlags(opts: Record<string, unknown>): {
  noOpen: boolean;
  noThinking: boolean;
} {
  return {
    noOpen: opts.open === false,
    noThinking: opts.thinking === false,
  };
}

export async function reportAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();
  const sessionId: string | undefined = opts.session;
  const outputPath: string | undefined = opts.output;
  const { noOpen, noThinking } = resolveReportFlags(opts);
  const theme: 'dark' | 'light' = opts.theme === 'light' ? 'light' : 'dark';

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
          onError: (_err: Error) => {
            /* ignore */
          },
        },
      });
      sessionPath = result.sessionPath;

      // Synchronous replay of all existing events
      result.watcher.start(true);
      result.watcher.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exitCode = 1;
      return;
    }

    // Process events through the aggregator for stats
    const aggregator = new EventAggregator({
      providerId: provider.id as 'claude-code' | 'opencode' | 'codex',
    });
    for (const event of events) {
      aggregator.processFollowEvent(event);
    }
    const metrics = aggregator.getMetrics();

    // Parse transcript for full content
    const transcript =
      provider.id === 'codex'
        ? parseTranscriptFromEvents(provider.createReader(sessionPath).readAll())
        : parseTranscript(sessionPath);

    // Generate HTML report
    const sessionFileName = path.basename(sessionPath);
    const reportOptions: HtmlReportOptions = {
      sessionFileName,
      includeThinking: !noThinking,
      includeToolDetail: true,
      theme,
    };
    const html = generateHtmlReport(metrics, transcript, reportOptions);

    // Write to output file
    const outFile = outputPath || path.join(os.tmpdir(), `sidekick-report-${Date.now()}.html`);
    fs.writeFileSync(outFile, html, 'utf-8');
    if (globalOpts.json) {
      process.stdout.write(
        `${JSON.stringify({ path: outFile, sessionPath, sessionFileName, bytes: Buffer.byteLength(html, 'utf8') })}\n`,
      );
    } else {
      process.stderr.write(`Report written to: ${outFile}\n`);
    }

    // Open in browser unless --no-open
    if (!noOpen) {
      openInBrowser(outFile);
    }
  } finally {
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
  }
}
