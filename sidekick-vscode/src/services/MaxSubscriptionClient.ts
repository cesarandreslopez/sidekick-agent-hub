/**
 * @fileoverview Claude client using Max subscription via Claude Code CLI.
 *
 * This client uses @anthropic-ai/claude-agent-sdk to make requests
 * through the Claude Code infrastructure, using a user's existing
 * Claude Max subscription instead of API billing.
 *
 * @module MaxSubscriptionClient
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ClaudeClient, CompletionOptions } from '../types';
import { log, logError } from './Logger';

// Type for the query function from the SDK
type QueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

// Cached query function after dynamic import
let cachedQuery: QueryFunction | null = null;

/**
 * Gets a working directory for the SDK.
 * Uses workspace folder if available, otherwise home directory.
 */
function getWorkingDirectory(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

/**
 * Common installation paths for the Claude CLI on different platforms.
 * These are checked when the CLI isn't found in PATH.
 */
function getCommonClaudePaths(): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.cmd' : '';

  return [
    // npm global (standard)
    path.join(homeDir, '.npm-global', 'bin', `claude${ext}`),
    // npm global (alternative)
    path.join(homeDir, 'npm-global', 'bin', `claude${ext}`),
    // pnpm global
    path.join(homeDir, '.local', 'share', 'pnpm', `claude${ext}`),
    // pnpm alternative location
    path.join(homeDir, 'Library', 'pnpm', `claude${ext}`),
    // yarn global
    path.join(homeDir, '.yarn', 'bin', `claude${ext}`),
    // volta
    path.join(homeDir, '.volta', 'bin', `claude${ext}`),
    // nvm (common node versions)
    path.join(homeDir, '.nvm', 'versions', 'node', '**', 'bin', `claude${ext}`),
    // Linux system paths
    `/usr/local/bin/claude${ext}`,
    `/usr/bin/claude${ext}`,
    // macOS Homebrew
    '/opt/homebrew/bin/claude',
    '/usr/local/opt/node/bin/claude',
    // Windows npm global
    ...(isWindows ? [
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'claude.cmd'),
    ] : []),
  ];
}

/**
 * Finds the Claude CLI executable path.
 *
 * Checks in order:
 * 1. User-configured path (sidekick.claudePath setting)
 * 2. Common installation paths
 * 3. Falls back to 'claude' (assumes it's in PATH)
 *
 * @returns The path to the claude executable, or 'claude' if not found
 */
function findClaudeCli(): string {
  // Check user-configured path first
  const config = vscode.workspace.getConfiguration('sidekick');
  const configuredPath = config.get<string>('claudePath');

  if (configuredPath && configuredPath.trim() !== '') {
    const expandedPath = configuredPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expandedPath)) {
      log(`Using configured claude path: ${expandedPath}`);
      return expandedPath;
    }
    log(`Configured claude path not found: ${expandedPath}`);
  }

  // Check common installation paths
  for (const candidatePath of getCommonClaudePaths()) {
    // Skip glob patterns (nvm paths with **)
    if (candidatePath.includes('**')) continue;

    if (fs.existsSync(candidatePath)) {
      log(`Found claude at: ${candidatePath}`);
      return candidatePath;
    }
  }

  // Fall back to 'claude' (hope it's in PATH)
  log('Claude not found in common paths, falling back to PATH lookup');
  return 'claude';
}

/**
 * Dynamically imports the SDK after patching process.cwd.
 * The SDK calls process.cwd() during module initialization,
 * which can be undefined in VS Code extensions.
 */
async function getQueryFunction(): Promise<QueryFunction> {
  if (cachedQuery) {
    log('Using cached query function');
    return cachedQuery;
  }

  const cwd = getWorkingDirectory();
  log(`Importing SDK with patched cwd: ${cwd}`);

  // Patch process.cwd before importing the SDK
  const originalCwd = process.cwd;
  process.cwd = () => cwd;

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    cachedQuery = sdk.query;
    log('SDK imported successfully');
    return cachedQuery;
  } catch (error) {
    logError('Failed to import SDK', error);
    throw error;
  } finally {
    // Restore original cwd after import
    process.cwd = originalCwd;
  }
}

/**
 * Claude client using Max subscription authentication.
 *
 * Uses @anthropic-ai/claude-agent-sdk which interfaces with the
 * Claude Code CLI. Requires the user to have:
 * 1. Claude Code CLI installed (npm install -g @anthropic-ai/claude-code)
 * 2. An active Claude Max subscription
 * 3. Being logged in via `claude login`
 *
 * @example
 * ```typescript
 * const client = new MaxSubscriptionClient();
 * const response = await client.complete('Hello!');
 * ```
 */
export class MaxSubscriptionClient implements ClaudeClient {
  /**
   * Sends a prompt to Claude and returns the completion.
   *
   * Uses the claude-agent-sdk query function which routes through
   * the Claude Code infrastructure.
   *
   * @param prompt - The text prompt to send
   * @param options - Optional completion configuration
   * @returns Promise resolving to the completion text
   * @throws Error if request times out or fails
   */
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const abortController = new AbortController();
    const timeoutMs = options?.timeout ?? 30000;
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    log(`MaxSubscriptionClient.complete called, model=${options?.model}, timeout=${timeoutMs}`);

    try {
      const query = await getQueryFunction();
      const cwd = getWorkingDirectory();

      log(`Starting query with cwd: ${cwd}`);

      for await (const message of query({
        prompt,
        options: {
          cwd,
          abortController,
          model: this.mapModel(options?.model),
          maxTurns: 1,
          allowedTools: [],
          permissionMode: 'bypassPermissions',
        },
      })) {
        log(`Received message: type=${message.type}, subtype=${'subtype' in message ? message.subtype : 'n/a'}`);
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            log('Query succeeded');
            return message.result;
          }
          // Log full message for debugging
          log(`Result message: ${JSON.stringify(message, null, 2)}`);
          const errorMsg = message.errors?.join(', ') || message.subtype || 'Unknown error';
          logError(`Query failed: ${errorMsg}`);
          throw new Error(errorMsg);
        }
      }
      throw new Error('No result received');
    } catch (error) {
      logError('MaxSubscriptionClient.complete error', error);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Tests if Claude Code CLI is available.
   *
   * Checks for the claude CLI in:
   * 1. User-configured path (sidekick.claudePath setting)
   * 2. Common installation paths (pnpm, npm, yarn, etc.)
   * 3. System PATH
   *
   * @returns Promise resolving to true if CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process');
      const claudePath = findClaudeCli();

      log(`Testing CLI availability with: ${claudePath}`);

      // Use shell: true to handle paths with spaces and resolve symlinks
      execSync(`"${claudePath}" --version`, { stdio: 'ignore', shell: true });
      log('Claude CLI is available');
      return true;
    } catch (error) {
      logError('Claude CLI not available', error);
      return false;
    }
  }

  /**
   * Maps shorthand model names for the Claude agent SDK.
   *
   * The agent SDK uses simple names: 'haiku', 'sonnet', 'opus'
   *
   * @param model - Shorthand model name or undefined
   * @returns Model name for agent SDK
   */
  private mapModel(model?: string): string {
    switch (model) {
      case 'haiku':
        return 'haiku';
      case 'sonnet':
        return 'sonnet';
      case 'opus':
        return 'opus';
      default:
        return 'haiku';
    }
  }

  /**
   * Disposes of the client resources.
   *
   * No cleanup needed as each request is independent.
   */
  dispose(): void {
    // No cleanup needed
  }
}
