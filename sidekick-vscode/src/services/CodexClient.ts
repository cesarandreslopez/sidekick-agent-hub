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

import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { getCodexExecutionEnv, resolveSidekickCodexHome } from 'sidekick-shared';
import { ClaudeClient, CompletionOptions, ConnectionError } from '../types';
import { log, logError } from './Logger';
import { findCli } from '../utils/cliPathResolver';
import { requestWithTimeout } from '../utils/requestWithTimeout';

/**
 * Finds the Codex CLI executable path.
 *
 * Checks common install locations then falls back to PATH resolution.
 */
function findCodexCli(): string {
  const result = findCli({ binaryName: 'codex' });
  if (result) return result;
  throw new ConnectionError(
    'Codex CLI not found. Install it (npm install -g @openai/codex) or choose a different inference provider.',
    'codex'
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
    const codexPath = findCodexCli();

    const args = ['exec', '--experimental-json', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (options?.model) {
      args.push('--model', options.model);
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(getCodexExecutionEnv())) {
      if (value !== undefined) env[key] = value;
    }
    if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
    }

    return requestWithTimeout(options, (signal) => {
      return new Promise<string>((resolve, reject) => {
        // Spawn the CLI
        const child = spawn(codexPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });

        // Kill child on abort (covers both timeout and user cancellation)
        signal.addEventListener('abort', () => {
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

        child.on('error', (err) => reject(err));

        child.on('close', (code) => {
          if (errorMessage) {
            reject(new Error(`Codex error: ${errorMessage}`));
          } else if (code !== 0 && code !== null) {
            reject(new Error(
              `Codex exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`
            ));
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    // Check for API key availability
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
      log('CodexClient: API key found in env');
      return true;
    }

    const codexHome = resolveSidekickCodexHome();
    if (
      fs.existsSync(path.join(codexHome, 'auth.json')) ||
      fs.existsSync(path.join(codexHome, '.credentials.json'))
    ) {
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
