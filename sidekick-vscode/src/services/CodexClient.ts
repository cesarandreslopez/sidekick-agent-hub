/**
 * @fileoverview Inference client using the Codex CLI directly.
 *
 * Implements ClaudeClient by spawning `codex exec --experimental-json`
 * and parsing JSONL events from stdout. This avoids bundling the
 * @openai/codex-sdk, whose module-level createRequire(import.meta.url)
 * and platform binary resolution break inside esbuild's CJS output.
 *
 * Readiness: an OPENAI_API_KEY / CODEX_API_KEY env var, else what
 * `codex login status` reports, else (when that command cannot run) an
 * auth.json or .credentials.json file in the Codex home.
 *
 * @module services/CodexClient
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import {
  getCodexExecutionEnv,
  parseCodexLoginStatus,
  resolveSidekickCodexHome,
  type ParsedCodexLoginStatus,
} from 'sidekick-shared';
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
    'codex',
  );
}

/** How long `codex login status` may take before readiness falls back to the auth file. */
const LOGIN_STATUS_TIMEOUT_MS = 5_000;

/** Codex error payloads kept as evidence for one request (`type: "error"` events). */
const MAX_ERROR_EVENTS = 8;

/** The child-process environment Codex runs with (its home and originator). */
function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(getCodexExecutionEnv())) {
    if (value !== undefined) env[key] = value;
  }
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The structured cause for a failed request: the `turn.failed` error object
 * (or, without one, the last `error` event) with every `error` event payload
 * under `errors`, so `codexErrorInfo` and status fields on any of them reach
 * `diagnoseProviderFailure`.
 */
function failureCause(
  turnFailure: Record<string, unknown> | undefined,
  errorEvents: Record<string, unknown>[],
): Record<string, unknown> {
  const primary = turnFailure ?? errorEvents[errorEvents.length - 1] ?? {};
  return errorEvents.length > 0 ? { ...primary, errors: errorEvents } : { ...primary };
}

/**
 * Runs `codex login status` (no shell) and parses it. Resolves null when the
 * command could not run, timed out, or printed something unrecognised, so the
 * caller falls back to the auth-file check.
 */
function readCodexLoginStatus(
  codexPath: string,
  env: Record<string, string>,
): Promise<ParsedCodexLoginStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ParsedCodexLoginStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexPath, ['login', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, LOGIN_STATUS_TIMEOUT_MS);
    timer.unref?.();
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const status = parseCodexLoginStatus(stdout, stderr);
      // `loggedIn: false` also covers output the parser does not recognise
      // (an older CLI without the subcommand); only "Not logged in" is a verdict.
      const recognised = status.loggedIn || /^not logged in/i.test(status.detail ?? '');
      finish(recognised ? status : null);
    });
  });
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

    const env = codexEnv();

    return requestWithTimeout(options, (signal) => {
      return new Promise<string>((resolve, reject) => {
        // Spawn the CLI
        const child = spawn(codexPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });

        // Kill child on abort (covers both timeout and user cancellation)
        signal.addEventListener(
          'abort',
          () => {
            if (!child.killed) {
              child.kill('SIGTERM');
              const forceKillTimer = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
              }, 5_000);
              forceKillTimer.unref();
            }
          },
          { once: true },
        );

        // Write prompt to stdin and close
        child.stdin.on('error', (error) => reject(error));
        child.stdin.write(prompt);
        child.stdin.end();

        // Collect stderr for error reporting
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        // Parse JSONL from stdout
        let response = '';
        let turnFailure: Record<string, unknown> | undefined;
        const errorEvents: Record<string, unknown>[] = [];

        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on('line', (line: string) => {
          try {
            const parsed = JSON.parse(line);
            const type = parsed.type;

            // item.completed with agent_message carries the response text
            if (type === 'item.completed' && parsed.item?.type === 'agent_message') {
              response = parsed.item.text ?? '';
            }

            // `error` events and turn.failed carry the failure, including any
            // structured `codexErrorInfo`; keep the whole payloads as evidence.
            if (type === 'error' && errorEvents.length < MAX_ERROR_EVENTS) {
              const payload = { ...parsed };
              delete payload.type;
              errorEvents.push(payload);
            }
            if (type === 'turn.failed' && isRecord(parsed.error)) {
              turnFailure = parsed.error;
            }
          } catch {
            // Skip non-JSON lines
          }
        });

        child.on('error', (err) => reject(err));

        child.on('close', (code) => {
          // A turn.failed always fails the request; error events fail it when
          // the CLI exited non-zero or produced no reply.
          const failed =
            turnFailure !== undefined ||
            (errorEvents.length > 0 && ((code !== 0 && code !== null) || !response));
          const cause = failed ? failureCause(turnFailure, errorEvents) : undefined;
          const failureMessage = [cause, ...errorEvents.slice().reverse()]
            .map((payload) => payload?.message)
            .find((message): message is string => typeof message === 'string' && message !== '');
          if (signal.aborted) {
            const error = new Error('Request was cancelled');
            error.name = 'AbortError';
            reject(error);
          } else if (cause && failureMessage) {
            reject(new Error(`Codex error: ${failureMessage}`, { cause }));
          } else if (cause) {
            reject(
              new Error(`Codex request failed${stderr ? ': ' + stderr.trim() : ''}`, { cause }),
            );
          } else if (code !== 0 && code !== null) {
            reject(
              new Error(`Codex exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`),
            );
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    const codexPath = findCodexCli();
    // Check for API key availability
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
      log('CodexClient: API key found in env');
      return true;
    }

    // Ask the CLI which credential it would use (it also reads the keyring).
    // When the command cannot run or times out, fall back to the auth file.
    const status = await readCodexLoginStatus(codexPath, codexEnv());
    if (status?.loggedIn) {
      log(`CodexClient: ${status.detail ?? 'logged in'}`);
      return true;
    }
    if (status) {
      logError(`CodexClient: ${status.detail ?? 'not logged in'}`);
      throw Object.assign(new Error('Codex CLI is not logged in. Run `codex login`.'), {
        code: 'missing_credentials',
      });
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
    throw Object.assign(new Error('No Codex credentials available'), {
      code: 'missing_credentials',
    });
  }

  dispose(): void {
    // No cached state to clean up
  }
}
