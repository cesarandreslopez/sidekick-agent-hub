/** A bounded, inference-free official CLI refresh. Never expose child output. */
import { spawn } from 'child_process';
import type { KeepAliveRunner } from './keepAlive';

export const runCodexKeepAlive: KeepAliveRunner = (command, args, env, timeoutMs) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: env.CODEX_HOME,
      });
    } catch {
      resolve({ status: null, stdout: '' });
      return;
    }
    let buffer = '';
    let bytes = 0;
    let initialized = false;
    let result: number | null = null;
    let finishing = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(status: number | null): void {
      if (finishing) return;
      finishing = true;
      result = status;
      child.stdin?.end();
      // The lease stays held until the child exits, including timeout/error paths.
      killTimer = setTimeout(() => child.kill('SIGKILL'), Math.min(1000, timeoutMs));
      if (status !== 0) child.kill('SIGKILL');
    }
    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ status: result, stdout: '' });
    }
    const send = (message: unknown): void => {
      if (!child.stdin?.writable) {
        finish(null);
        return;
      }
      child.stdin.write(JSON.stringify(message) + '\n');
    };
    child.once('error', settle);
    child.once('close', settle);
    child.once('exit', settle);
    child.stdin?.on('error', () => finish(null));
    child.stderr?.on('data', () => {
      /* Drain, never log possibly sensitive diagnostics. */
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (finishing) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        finish(null);
        return;
      }
      buffer += chunk;
      let newline: number;
      while (!finishing && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: {
          id?: number;
          error?: unknown;
          result?: { account?: { type?: string } };
          method?: string;
        };
        try {
          message = JSON.parse(line);
        } catch {
          finish(null);
          return;
        }
        if (!message || typeof message !== 'object') {
          finish(null);
          return;
        }
        if (message.id === 0 && !initialized) {
          if (message.error || !message.result) {
            finish(1);
            return;
          }
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ method: 'account/read', id: 1, params: { refreshToken: true } });
        } else if (message.id === 1 && initialized) {
          finish(!message.error && message.result?.account?.type === 'chatgpt' ? 0 : 1);
        }
      }
    });
    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'sidekick_agent_hub', title: 'Sidekick Agent Hub', version: '1' },
        capabilities: null,
      },
    });
  });
