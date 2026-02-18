/**
 * @fileoverview Inference client using the Codex CLI directly.
 *
 * Implements ClaudeClient by spawning `codex exec --experimental-json`
 * and parsing JSONL events from stdout. This avoids bundling the
 * @openai/codex-sdk, whose module-level createRequire(import.meta.url)
 * and platform binary resolution break inside esbuild's CJS output.
 *
 * Requires an OpenAI API key via OPENAI_API_KEY or CODEX_API_KEY env var,
 * or a credentials file at ~/.codex/.credentials.json.
 *
 * @module services/CodexClient
 */

import { spawn, execSync } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeClient, CompletionOptions, TimeoutError } from '../types';
import { log, logError } from './Logger';

/**
 * Resolves a command to its absolute path using which/where.
 */
function resolveCommand(command: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const resolved = result.trim().split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* not found */ }
  return null;
}

/**
 * Finds the Codex CLI executable path.
 *
 * Checks common install locations then falls back to PATH resolution.
 */
function findCodexCli(): string {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.cmd' : '';

  const candidates = [
    // npm global
    path.join(homeDir, '.npm-global', 'bin', `codex${ext}`),
    // pnpm global
    path.join(homeDir, '.local', 'share', 'pnpm', `codex${ext}`),
    // yarn global
    path.join(homeDir, '.yarn', 'bin', `codex${ext}`),
    // volta
    path.join(homeDir, '.volta', 'bin', `codex${ext}`),
    // System paths
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    // Homebrew
    '/opt/homebrew/bin/codex',
    // Windows
    ...(isWindows ? [
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'codex.cmd'),
    ] : []),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      log(`Found codex at: ${p}`);
      return p;
    }
  }

  // Fall back to PATH
  const resolved = resolveCommand('codex');
  if (resolved) {
    log(`Resolved codex from PATH: ${resolved}`);
    return resolved;
  }

  throw new Error(
    'Codex CLI not found. Install it (npm install -g @openai/codex) or choose a different inference provider.'
  );
}

/**
 * Inference client that routes completions through the Codex CLI.
 *
 * Spawns `codex exec --experimental-json` as a child process,
 * writes the prompt to stdin, and parses JSONL events from stdout
 * to extract the final response.
 */
export class CodexClient implements ClaudeClient {
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    if (options?.signal?.aborted) {
      const err = new Error('Request was cancelled');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutMs = options?.timeout ?? 30000;
    const codexPath = findCodexCli();

    const args = ['exec', '--experimental-json', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (options?.model) {
      args.push('--model', options.model);
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
    }

    return new Promise<string>((resolve, reject) => {
      // Internal controller unifies external abort + timeout
      const controller = new AbortController();
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        controller.abort();
        fn();
      };

      // Timeout
      const timer = setTimeout(() => {
        settle(() => reject(new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs)));
      }, timeoutMs);

      // External abort
      const onAbort = () => {
        clearTimeout(timer);
        settle(() => {
          const err = new Error('Request was cancelled');
          err.name = 'AbortError';
          reject(err);
        });
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      // Spawn the CLI
      const child = spawn(codexPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      // Kill child on abort
      controller.signal.addEventListener('abort', () => {
        if (!child.killed) child.kill('SIGTERM');
      }, { once: true });

      // Write prompt to stdin and close
      child.stdin.write(prompt);
      child.stdin.end();

      // Collect stderr for error reporting
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // Parse JSONL from stdout
      let response = '';
      let errorMessage = '';

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line: string) => {
        try {
          const parsed = JSON.parse(line);
          const type = parsed.type;

          // item.completed with agent_message carries the response text
          if (type === 'item.completed' && parsed.item?.type === 'agent_message') {
            response = parsed.item.text ?? '';
          }

          // turn.failed carries error info
          if (type === 'turn.failed' && parsed.error?.message) {
            errorMessage = parsed.error.message;
          }
        } catch {
          // Skip non-JSON lines
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        settle(() => reject(err));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);

        if (settled) return;

        if (errorMessage) {
          settle(() => reject(new Error(`Codex error: ${errorMessage}`)));
        } else if (code !== 0 && code !== null) {
          settle(() => reject(new Error(
            `Codex exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`
          )));
        } else {
          settle(() => resolve(response));
        }
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    // Check for API key availability
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
      log('CodexClient: API key found in env');
      return true;
    }

    const credPath = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      '.credentials.json'
    );
    if (fs.existsSync(credPath)) {
      log('CodexClient: credentials file found');
      return true;
    }

    logError('CodexClient: no API key or credentials found');
    return false;
  }

  dispose(): void {
    // No cached state to clean up
  }
}
