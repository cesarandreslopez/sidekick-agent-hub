/**
 * `sidekick search` — Full-text search across all sessions.
 *
 * Searches session data across all projects (or a specific project) for the
 * given query string. Results include matched snippets with highlighted terms,
 * event types, timestamps, and session/project paths.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { searchSessions } from 'sidekick-shared';
import type { SearchResult } from 'sidekick-shared';
import { resolveProvider } from '../cli';

/**
 * Highlight all occurrences of `query` in `text` using chalk yellow+bold.
 * Case-insensitive matching preserves the original casing in output.
 */
function highlightMatches(text: string, query: string): string {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  return text.replace(regex, (match) => chalk.yellow.bold(match));
}

/**
 * Format a single search result for terminal output.
 */
function formatResult(result: SearchResult, query: string, index: number): string {
  const lines: string[] = [];

  // Header line: index, event type, timestamp
  const idx = chalk.dim(`[${index + 1}]`);
  const eventTag = result.eventType
    ? chalk.cyan(`[${result.eventType}]`)
    : chalk.dim('[unknown]');
  const ts = result.timestamp
    ? chalk.dim(result.timestamp)
    : '';
  lines.push(`${idx} ${eventTag} ${ts}`);

  // Snippet with highlighted matches
  const snippet = result.snippet.trim();
  const maxLen = 200;
  const truncated = snippet.length > maxLen
    ? snippet.substring(0, maxLen) + '...'
    : snippet;
  lines.push(`    ${highlightMatches(truncated, query)}`);

  // Project and session path
  lines.push(`    ${chalk.dim('project:')} ${result.projectPath}`);
  lines.push(`    ${chalk.dim('session:')} ${result.sessionPath}`);

  return lines.join('\n');
}

export async function searchAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const query: string = opts.query as string;
  const jsonOutput: boolean = !!globalOpts.json || !!opts.json;
  const limit: number = opts.limit ? parseInt(opts.limit as string, 10) : 50;

  if (!query || query.trim().length === 0) {
    process.stderr.write('Error: search query is required\n');
    process.exit(1);
  }

  const provider = resolveProvider(globalOpts);

  try {
    // Determine project slug if --project is specified
    const projectPath: string | undefined = globalOpts.project || undefined;
    let projectSlug: string | undefined;
    if (projectPath) {
      // Use the provider's encoding to match folder names
      const path = await import('path');
      const resolved = path.resolve(projectPath);
      // The projectSlug in searchSessions filters by encodedName,
      // which corresponds to the folder name under the provider's base dir
      const { encodeWorkspacePath } = await import('sidekick-shared');
      projectSlug = encodeWorkspacePath(resolved);
    }

    const results: SearchResult[] = await searchSessions(provider, query.trim(), {
      projectSlug,
      maxResults: limit,
    });

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      return;
    }

    if (results.length === 0) {
      process.stderr.write(chalk.dim(`No results found for "${query}"\n`));
      return;
    }

    // Summary header
    const countLabel = results.length === limit
      ? `${results.length}+ matches`
      : `${results.length} match${results.length === 1 ? '' : 'es'}`;
    process.stdout.write(
      chalk.bold(`Search results for "${query}"`) + chalk.dim(` (${countLabel})`) + '\n\n'
    );

    // Render each result
    for (let i = 0; i < results.length; i++) {
      process.stdout.write(formatResult(results[i], query, i) + '\n');
      if (i < results.length - 1) {
        process.stdout.write(chalk.dim('  ───') + '\n');
      }
    }

    process.stdout.write('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  } finally {
    try { provider.dispose(); } catch { /* ignore */ }
  }
}
