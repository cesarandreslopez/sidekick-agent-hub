/**
 * Provider-aware inference client for the CLI dashboard.
 * Supports multiple strategies depending on the active session provider:
 *
 * - Claude Code: `claude --print` CLI first, then ANTHROPIC_API_KEY via fetch
 * - OpenCode: ANTHROPIC_API_KEY via fetch
 * - Codex: OPENAI_API_KEY or CODEX_API_KEY via fetch, or `codex exec`
 *
 * Uses native fetch() (Node 18+) — no new npm dependencies.
 */

import { spawn, execSync, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import type { ProviderId, ProviderFailureDiagnosis, ProviderFailureInput } from 'sidekick-shared';
import { getCodexExecutionEnv, diagnoseProviderFailure } from 'sidekick-shared';

export interface InferenceResult {
  text: string;
  error?: string;
  diagnosis?: ProviderFailureDiagnosis;
}

type Strategy = 'claude-cli' | 'anthropic-api' | 'openai-api' | 'codex-cli' | 'none';

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: 60_000,
  maxBuffer: 1024 * 1024,
};

export class CliInferenceClient {
  private providerId: ProviderId;
  private strategy: Strategy = 'none';
  private availabilityChecked = false;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  /** Probe for an available inference strategy based on the active provider. */
  async checkAvailability(): Promise<boolean> {
    this.availabilityChecked = true;
    this.strategy = this.detectStrategy();
    return this.strategy !== 'none';
  }

  /** Return a human-readable explanation of how to enable inference. */
  getEnableHint(): string {
    switch (this.providerId) {
      case 'claude-code':
        return 'Install claude CLI or set ANTHROPIC_API_KEY';
      case 'opencode':
        return 'Set ANTHROPIC_API_KEY environment variable';
      case 'codex':
        return 'Set OPENAI_API_KEY or CODEX_API_KEY, or install codex CLI';
      default:
        return 'Set ANTHROPIC_API_KEY environment variable';
    }
  }

  get isAvailable(): boolean {
    return this.strategy !== 'none';
  }

  /** Generate a completion from the given prompt. */
  async complete(prompt: string): Promise<InferenceResult> {
    if (!this.availabilityChecked) {
      await this.checkAvailability();
    }

    switch (this.strategy) {
      case 'claude-cli':
        return this.completeViaClaude(prompt);
      case 'anthropic-api':
        return this.completeViaAnthropicApi(prompt);
      case 'openai-api':
        return this.completeViaOpenAiApi(prompt);
      case 'codex-cli':
        return this.completeViaCodexCli(prompt);
      case 'none':
        return { text: '', error: `No inference available. ${this.getEnableHint()}` };
    }
  }

  private detectStrategy(): Strategy {
    switch (this.providerId) {
      case 'claude-code':
        if (this.hasClaudeCli()) return 'claude-cli';
        if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
        return 'none';
      case 'opencode':
        if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
        return 'none';
      case 'codex':
        if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return 'openai-api';
        if (this.hasCodexCli()) return 'codex-cli';
        return 'none';
      default:
        if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
        return 'none';
    }
  }

  private hasClaudeCli(): boolean {
    try {
      execSync('which claude', { ...EXEC_OPTS, timeout: 5_000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private hasCodexCli(): boolean {
    try {
      execSync('which codex', { ...EXEC_OPTS, timeout: 5_000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private completeViaClaude(prompt: string): Promise<InferenceResult> {
    // Pipe prompt via stdin to avoid argument length limits and escaping issues
    return spawnWithStdin('claude', ['--print'], prompt, undefined, {
      provider: 'claude-code',
      credentialKind: 'unknown',
    });
  }

  private async completeViaAnthropicApi(prompt: string): Promise<InferenceResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      return this.apiFailure(
        { code: 'missing_credentials' },
        'ANTHROPIC_API_KEY not set',
        'claude-code',
      );

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: DEFAULT_ANTHROPIC_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return this.apiFailure(
          { status: response.status, headers: response.headers, body },
          `API error ${response.status}: ${body.substring(0, 200)}`,
          'claude-code',
        );
      }

      const data = (await response.json()) as { content: Array<{ text: string }> };
      const text = data.content?.map((b) => b.text).join('') || '';
      return { text };
    } catch (err) {
      return this.apiFailure(err, `Anthropic API failed: ${(err as Error).message}`, 'claude-code');
    }
  }

  private async completeViaOpenAiApi(prompt: string): Promise<InferenceResult> {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    if (!apiKey)
      return this.apiFailure(
        { code: 'missing_credentials' },
        'OPENAI_API_KEY/CODEX_API_KEY not set',
        'codex',
      );

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_OPENAI_MODEL,
          max_completion_tokens: 1024,
          // Dashboard summaries need a short answer within the output budget.
          reasoning_effort: 'none',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return this.apiFailure(
          { status: response.status, headers: response.headers, body },
          `API error ${response.status}: ${body.substring(0, 200)}`,
          'codex',
        );
      }

      const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const text = data.choices?.[0]?.message?.content || '';
      return { text };
    } catch (err) {
      return this.apiFailure(err, `OpenAI API failed: ${(err as Error).message}`, 'codex');
    }
  }

  private apiFailure(
    error: unknown,
    message: string,
    provider: 'claude-code' | 'codex',
  ): InferenceResult {
    return {
      text: '',
      error: message,
      diagnosis: diagnoseProviderFailure({ provider, credentialKind: 'api-key', error }),
    };
  }

  private completeViaCodexCli(prompt: string): Promise<InferenceResult> {
    return spawnWithStdin('codex', ['exec'], prompt, getCodexExecutionEnv(), {
      provider: 'codex',
      credentialKind: 'unknown',
    });
  }
}

/** Spawn a CLI process and pipe the prompt via stdin. */
export function spawnWithStdin(
  cmd: string,
  args: string[],
  prompt: string,
  env?: NodeJS.ProcessEnv,
  context?: Pick<ProviderFailureInput, 'provider' | 'credentialKind'>,
): Promise<InferenceResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: InferenceResult, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        result.error && context
          ? {
              ...result,
              diagnosis: diagnoseProviderFailure({ ...context, error: error ?? result.error }),
            }
          : result,
      );
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5_000);
      forceKillTimer.unref();
      finish({ text: '', error: `${cmd} CLI timed out after 60s` });
    }, 60_000);
    timer.unref();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (code !== 0) {
        finish(
          {
            text: '',
            error: `${cmd} CLI failed (exit ${code}): ${stderr.substring(0, 200)}`,
          },
          { message: stderr },
        );
      } else {
        finish({ text: stdout.trim() });
      }
    });

    proc.on('error', (err) => {
      finish({ text: '', error: `${cmd} CLI failed: ${err.message}` }, err);
    });

    proc.stdin.on('error', (err) => {
      finish({ text: '', error: `${cmd} CLI stdin failed: ${err.message}` }, err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
