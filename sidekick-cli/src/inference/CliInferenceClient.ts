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
import type { ProviderId } from 'sidekick-shared';

export interface InferenceResult {
  text: string;
  error?: string;
}

type Strategy = 'claude-cli' | 'anthropic-api' | 'openai-api' | 'codex-cli' | 'none';

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

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
    } catch { return false; }
  }

  private hasCodexCli(): boolean {
    try {
      execSync('which codex', { ...EXEC_OPTS, timeout: 5_000, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  private completeViaClaude(prompt: string): Promise<InferenceResult> {
    // Pipe prompt via stdin to avoid argument length limits and escaping issues
    return spawnWithStdin('claude', ['--print'], prompt);
  }

  private async completeViaAnthropicApi(prompt: string): Promise<InferenceResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { text: '', error: 'ANTHROPIC_API_KEY not set' };

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
        return { text: '', error: `API error ${response.status}: ${body.substring(0, 200)}` };
      }

      const data = await response.json() as { content: Array<{ text: string }> };
      const text = data.content?.map(b => b.text).join('') || '';
      return { text };
    } catch (err) {
      return { text: '', error: `Anthropic API failed: ${(err as Error).message}` };
    }
  }

  private async completeViaOpenAiApi(prompt: string): Promise<InferenceResult> {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    if (!apiKey) return { text: '', error: 'OPENAI_API_KEY/CODEX_API_KEY not set' };

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_OPENAI_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return { text: '', error: `API error ${response.status}: ${body.substring(0, 200)}` };
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const text = data.choices?.[0]?.message?.content || '';
      return { text };
    } catch (err) {
      return { text: '', error: `OpenAI API failed: ${(err as Error).message}` };
    }
  }

  private completeViaCodexCli(prompt: string): Promise<InferenceResult> {
    return spawnWithStdin('codex', ['exec'], prompt);
  }
}

/** Spawn a CLI process and pipe the prompt via stdin. */
function spawnWithStdin(cmd: string, args: string[], prompt: string): Promise<InferenceResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ text: '', error: `${cmd} CLI timed out after 60s` });
    }, 60_000);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ text: '', error: `${cmd} CLI failed (exit ${code}): ${stderr.substring(0, 200)}` });
      } else {
        resolve({ text: stdout.trim() });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ text: '', error: `${cmd} CLI failed: ${err.message}` });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
