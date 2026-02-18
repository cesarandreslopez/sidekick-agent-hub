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
import { execSync } from 'child_process';
import { ClaudeClient, CompletionOptions, TimeoutError } from '../types';
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
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const ext = isWindows ? '.cmd' : '';

  const platformPaths: string[] = [];

  // Native Claude Code installer paths (platform-specific) - check first as preferred
  if (platform === 'linux') {
    platformPaths.push(path.join(homeDir, '.local', 'bin', 'claude'));
  } else if (platform === 'darwin') {
    platformPaths.push('/usr/local/bin/claude');
    platformPaths.push(path.join(homeDir, '.claude', 'local', 'claude'));
  } else if (isWindows) {
    platformPaths.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude', 'claude.exe'));
    platformPaths.push(path.join(process.env.LOCALAPPDATA || '', 'Claude', 'claude.exe'));
  }

  return [
    ...platformPaths,
    // npm global
    path.join(homeDir, '.npm-global', 'bin', `claude${ext}`),
    path.join(homeDir, 'npm-global', 'bin', `claude${ext}`),
    // pnpm global
    path.join(homeDir, '.local', 'share', 'pnpm', `claude${ext}`),
    path.join(homeDir, 'Library', 'pnpm', `claude${ext}`),
    // yarn global
    path.join(homeDir, '.yarn', 'bin', `claude${ext}`),
    // volta
    path.join(homeDir, '.volta', 'bin', `claude${ext}`),
    // nvm (common node versions)
    path.join(homeDir, '.nvm', 'versions', 'node', '**', 'bin', `claude${ext}`),
    // System paths
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    // macOS Homebrew
    '/opt/homebrew/bin/claude',
    '/usr/local/opt/node/bin/claude',
    // Windows npm/pnpm global
    ...(isWindows ? [
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'claude.cmd'),
    ] : []),
  ];
}

/**
 * Resolves a command name to its absolute path using the system's PATH.
 * Works cross-platform: `which` on Unix, `where` on Windows.
 *
 * @param command - The command name to resolve (e.g., 'claude')
 * @returns The absolute path to the command, or null if not found
 */
function resolveCommandPath(command: string): string | null {
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? `where ${command}` : `which ${command}`;
    const result = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // `where` on Windows may return multiple lines; take the first
    const resolvedPath = result.trim().split(/\r?\n/)[0];
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      log(`Resolved '${command}' from PATH: ${resolvedPath}`);
      return resolvedPath;
    }
  } catch {
    // Command not found in PATH
  }
  return null;
}

/**
 * Finds the Claude CLI executable path.
 *
 * Checks in order:
 * 1. User-configured path (sidekick.claudePath setting)
 * 2. Common installation paths
 * 3. Resolves 'claude' from system PATH to absolute path
 *
 * @returns The absolute path to the claude executable
 * @throws Error if claude CLI cannot be found
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

  // Try to resolve 'claude' from PATH to get absolute path
  // (The SDK requires an absolute path, not just a command name)
  log('Claude not found in common paths, resolving from PATH...');
  const resolvedPath = resolveCommandPath('claude');
  if (resolvedPath) {
    return resolvedPath;
  }

  // Could not find claude anywhere
  throw new Error(
    'Claude CLI not found. Please install Claude Code (https://claude.ai/download) ' +
    'or set the path manually in Settings > Sidekick: Claude Path'
  );
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
 * Attempts to find the Claude CLI and offers to save the path to settings.
 * Useful for diagnostics when auto-detection isn't working.
 *
 * @returns Object with found path and whether it was saved to settings
 */
export async function suggestClaudePath(): Promise<{
  found: boolean;
  path?: string;
  savedToSettings: boolean;
}> {
  // First check if it's already configured
  const config = vscode.workspace.getConfiguration('sidekick');
  const configuredPath = config.get<string>('claudePath');
  if (configuredPath && configuredPath.trim() !== '') {
    const expandedPath = configuredPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expandedPath)) {
      return { found: true, path: expandedPath, savedToSettings: false };
    }
  }

  // Try to resolve from PATH
  const resolvedPath = resolveCommandPath('claude');
  if (!resolvedPath) {
    vscode.window.showErrorMessage(
      'Claude CLI not found. Please install Claude Code from https://claude.ai/download'
    );
    return { found: false, savedToSettings: false };
  }

  // Found it - offer to save to settings
  const action = await vscode.window.showInformationMessage(
    `Found Claude CLI at: ${resolvedPath}`,
    'Save to Settings',
    'Dismiss'
  );

  if (action === 'Save to Settings') {
    await config.update('claudePath', resolvedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Saved Claude path to settings: ${resolvedPath}`);
    return { found: true, path: resolvedPath, savedToSettings: true };
  }

  return { found: true, path: resolvedPath, savedToSettings: false };
}

/**
 * Pre-warms the SDK by importing it early.
 * Call this on extension activation to reduce first-request latency.
 * The actual Claude Code process still spawns per-request, but
 * at least the SDK module will be loaded and ready.
 */
export async function warmupSdk(): Promise<void> {
  try {
    log('Pre-warming SDK...');
    await getQueryFunction();
    log('SDK pre-warmed successfully');
  } catch (error) {
    // Non-fatal - will try again on first real request
    logError('SDK pre-warm failed (will retry on first request)', error);
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

    // Link external signal to our internal abort controller if provided
    let externalAbortHandler: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        throw new Error('Request was cancelled');
      }
      externalAbortHandler = () => abortController.abort();
      options.signal.addEventListener('abort', externalAbortHandler);
    }

    log(`MaxSubscriptionClient.complete called, model=${options?.model}, timeout=${timeoutMs}`);

    try {
      const query = await getQueryFunction();
      const cwd = getWorkingDirectory();

      log(`Starting query with cwd: ${cwd}`);

      const claudePath = findClaudeCli();
      log(`Using Claude CLI at: ${claudePath}`);

      for await (const message of query({
        prompt,
        options: {
          cwd,
          abortController,
          model: this.mapModel(options?.model),
          maxTurns: 1,
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          pathToClaudeCodeExecutable: claudePath,
          // Disable session persistence to prevent SDK calls from creating JSONL files
          // that would pollute SessionMonitor data (token counts, timeline, tool analytics)
          persistSession: false,
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
        // Check if external signal was aborted (user cancellation) vs timeout
        if (options?.signal?.aborted) {
          const abortError = new Error('Request was cancelled');
          abortError.name = 'AbortError';
          throw abortError;
        }
        throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      // Clean up external signal listener
      if (externalAbortHandler && options?.signal) {
        options.signal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  /**
   * Tests if Claude Code CLI is available.
   *
   * Checks for the claude CLI in:
   * 1. User-configured path (sidekick.claudePath setting)
   * 2. Common installation paths (pnpm, npm, yarn, etc.)
   * 3. System PATH (resolved to absolute path)
   *
   * @returns Promise resolving to true if CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const claudePath = findClaudeCli();

      log(`Testing CLI availability with: ${claudePath}`);

      // Use shell: true to handle paths with spaces
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execSync(`"${claudePath}" --version`, { stdio: 'ignore', shell: true } as any);
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
   * The agent SDK uses simple names: 'haiku', 'sonnet', 'opus'.
   * Unknown models default to 'haiku'.
   *
   * @param model - Shorthand model name or undefined
   * @returns Model name for agent SDK
   */
  private mapModel(model?: string): string {
    const validModels = ['haiku', 'sonnet', 'opus'];
    return model && validModels.includes(model) ? model : 'haiku';
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
