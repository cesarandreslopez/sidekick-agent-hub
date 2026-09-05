/**
 * `sidekick import` — Fold finished sessions from every provider into the
 * history store (`historical-data.json`) that `sidekick stats`, `today`, and
 * the VS Code History tab read.
 *
 * Uses the same shared importer and store mutation as the extension's
 * first-activation import, so both hosts credit sessions identically. The
 * session logs are read without holding the store lock; the summaries are
 * then applied in one short locked read-modify-write, re-checking against
 * the on-disk store so a concurrent extension write is never overwritten
 * with stale data.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  HISTORICAL_DATA_SCHEMA_VERSION,
  applySessionSummary,
  createEmptyDataStore,
  getGlobalDataPath,
  importSessionHistory,
  markFileImported,
  readHistory,
  updateJsonStoreAtomic,
} from 'sidekick-shared';
import type { HistoricalDataStore, ProviderId, SessionSummary } from 'sidekick-shared';
import { parseTimeOption } from '../timeRange';
import { selectProviders } from './usageReports';

export interface ImportReport {
  storePath: string;
  providers: ProviderId[];
  since: string | null;
  filesFound: number;
  filesProcessed: number;
  filesSkipped: number;
  filesUnavailable: number;
  sessionsImported: number;
  messagesImported: number;
  /** Sessions the extension persisted while this import ran; not re-credited. */
  sessionsAlreadyPresent: number;
  diagnostics: string[];
}

interface PendingImport {
  summary: SessionSummary | null;
  filePath: string;
}

/** Fold pending summaries into the on-disk store under its lock. */
export function applyPendingImports(
  latest: HistoricalDataStore,
  pending: readonly PendingImport[],
  now: Date = new Date(),
): { applied: number; alreadyPresent: number } {
  latest.schemaVersion = HISTORICAL_DATA_SCHEMA_VERSION;
  latest.sessions ??= [];
  const files = new Set(latest.importedFiles ?? []);
  const sessionIds = new Set(latest.sessions.map((session) => session.sessionId));
  let applied = 0;
  let alreadyPresent = 0;
  for (const item of pending) {
    if (item.summary) {
      if (files.has(item.filePath) || sessionIds.has(item.summary.sessionId)) {
        alreadyPresent += 1;
      } else {
        applySessionSummary(latest, item.summary, { now });
        sessionIds.add(item.summary.sessionId);
        applied += 1;
      }
    }
    markFileImported(latest, item.filePath, now);
    files.add(item.filePath);
  }
  latest.lastSaved = now.toISOString();
  return { applied, alreadyPresent };
}

export async function importAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput = !!globalOpts.json;
  const now = new Date();

  let since: Date | undefined;
  if (localOpts.since) {
    try {
      since = parseTimeOption(String(localOpts.since), now);
    } catch (error) {
      process.stderr.write(
        chalk.red(error instanceof Error ? error.message : String(error)) + '\n',
      );
      process.exitCode = 1;
      return;
    }
  }

  const providers = selectProviders(globalOpts);
  const storePath = getGlobalDataPath('historical-data.json');
  try {
    const current = (await readHistory()) ?? createEmptyDataStore();
    const importedFiles = new Set(current.importedFiles ?? []);
    const sessionIds = new Set((current.sessions ?? []).map((session) => session.sessionId));
    const pending: PendingImport[] = [];
    let lastReported = 0;

    const result = await importSessionHistory({
      providers,
      since,
      workspacePath: globalOpts.project ? String(globalOpts.project) : undefined,
      now,
      isImported: (sessionId, filePath) => importedFiles.has(filePath) || sessionIds.has(sessionId),
      applySummary: (summary, filePath) => {
        pending.push({ summary, filePath });
        sessionIds.add(summary.sessionId);
      },
      markImported: (filePath) => {
        if (!pending.some((item) => item.filePath === filePath)) {
          pending.push({ summary: null, filePath });
        }
        importedFiles.add(filePath);
      },
      onProgress: (loaded, total) => {
        if (jsonOutput || total < 50) return;
        if (loaded === total || loaded - lastReported >= 100) {
          lastReported = loaded;
          process.stderr.write(chalk.dim(`  ${loaded}/${total} session files\n`));
        }
      },
    });

    let applied = 0;
    let alreadyPresent = 0;
    if (pending.length > 0) {
      await updateJsonStoreAtomic(storePath, createEmptyDataStore, (latest) => {
        const outcome = applyPendingImports(latest, pending, new Date());
        applied = outcome.applied;
        alreadyPresent = outcome.alreadyPresent;
        return latest;
      });
    }

    const report: ImportReport = {
      storePath,
      providers: providers.map((provider) => provider.id),
      since: since ? since.toISOString() : null,
      filesFound: result.filesFound,
      filesProcessed: result.filesProcessed,
      filesSkipped: result.filesSkipped,
      filesUnavailable: result.filesUnavailable,
      sessionsImported: applied,
      messagesImported: result.messagesImported,
      sessionsAlreadyPresent: alreadyPresent,
      diagnostics: result.diagnostics.map((diagnostic) => diagnostic.message),
    };

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    if (report.filesFound === 0) {
      process.stdout.write(chalk.dim('No session files found for the selected providers.\n'));
      return;
    }
    process.stdout.write(
      `Imported ${chalk.bold(String(report.sessionsImported))} session${report.sessionsImported === 1 ? '' : 's'} (${report.messagesImported.toLocaleString()} messages) from ${report.providers.join(', ')} into ${chalk.dim(storePath)}\n`,
    );
    const notes: string[] = [];
    if (report.filesSkipped > 0)
      notes.push(`${report.filesSkipped} already imported or still active`);
    if (report.filesUnavailable > 0)
      notes.push(`${report.filesUnavailable} without usage or unreadable`);
    if (report.sessionsAlreadyPresent > 0) {
      notes.push(`${report.sessionsAlreadyPresent} persisted meanwhile by the extension`);
    }
    if (notes.length > 0) process.stdout.write(chalk.dim(`  ${notes.join(' · ')}\n`));
    for (const diagnostic of report.diagnostics) {
      process.stdout.write(chalk.yellow(`  ⚠ ${diagnostic}\n`));
    }
    if (report.sessionsImported > 0) {
      process.stdout.write(chalk.dim('  Run "sidekick stats" to see the updated history.\n'));
    }
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  } finally {
    for (const provider of providers) provider.dispose();
  }
}
