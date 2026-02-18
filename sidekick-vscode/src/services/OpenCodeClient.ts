/**
 * @fileoverview Inference client using OpenCode SDK.
 *
 * Implements ClaudeClient by delegating to a running (or freshly spawned)
 * OpenCode server via @opencode-ai/sdk.
 *
 * @module services/OpenCodeClient
 */

import { ClaudeClient, CompletionOptions, TimeoutError } from '../types';
import { log, logError } from './Logger';

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = '127.0.0.1';

// Lazy-loaded SDK reference
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdkModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverHandle: any = null;

/**
 * Inference client that routes completions through OpenCode.
 *
 * Uses @opencode-ai/sdk to attach to a running OpenCode instance
 * (default port 4096), falling back to spawning a new server.
 * The model value passed to complete() is forwarded as-is; OpenCode's
 * own model configuration takes precedence.
 */
export class OpenCodeClient implements ClaudeClient {
  /**
   * Lazily loads the SDK and establishes a client connection.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (clientInstance) return clientInstance;

    if (!sdkModule) {
      try {
        // Use require() so esbuild can statically bundle the SDK
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        sdkModule = require('@opencode-ai/sdk');
      } catch {
        throw new Error(
          'OpenCode SDK not installed. Install @opencode-ai/sdk or choose a different inference provider.'
        );
      }
    }

    // Try attaching to a running server first
    const baseUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    try {
      const client = sdkModule.createOpencodeClient({ baseUrl });
      // Verify it's actually reachable (SDK has no health endpoint; use session.list)
      await client.session.list();
      clientInstance = client;
      log(`OpenCodeClient: attached to running OpenCode server at ${baseUrl}`);
      return clientInstance;
    } catch {
      log('OpenCodeClient: no running server found, will attempt to spawn');
    }

    // Fall back to spawning a new server
    try {
      const opencode = await sdkModule.createOpencode({
        hostname: DEFAULT_HOST,
        port: DEFAULT_PORT,
      });
      // createOpencode returns { client, server }
      serverHandle = opencode.server;
      clientInstance = opencode.client;
      log('OpenCodeClient: spawned new OpenCode server');
      return clientInstance;
    } catch (err) {
      throw new Error(
        `Failed to connect to OpenCode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    if (options?.signal?.aborted) {
      const err = new Error('Request was cancelled');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutMs = options?.timeout ?? 30000;
    const client = await this.getClient();

    const work = async (): Promise<string> => {
      // Create a session
      const session = await client.session.create({ body: {} });
      const sessionId = session.data?.id ?? session.id;
      log(`OpenCodeClient: created session ${sessionId}`);

      // Build prompt body
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {
        parts: [{ type: 'text', text: prompt }],
      };

      // Pass model only if it's a concrete provider/model identifier.
      // Tier names (fast/balanced/powerful) are Sidekick-internal and have no
      // meaning to OpenCode — omit them so OpenCode uses its own configured model.
      if (options?.model) {
        const m = options.model;
        if (m.includes('/')) {
          // Explicit provider/model format (e.g., "anthropic/claude-sonnet-4-20250514")
          const [providerID, modelID] = m.split('/', 2);
          body.model = { providerID, modelID };
        } else if (m !== 'fast' && m !== 'balanced' && m !== 'powerful') {
          // Specific model ID without provider — skip, as OpenCode requires providerID.
          // Users who want to target a specific model should use "provider/model" format.
          log(`OpenCodeClient: model "${m}" has no providerID, using OpenCode default`);
        }
      }

      // Send prompt and wait for response
      // SDK prompt() returns { data: { info, parts }, request, response }
      const response = await client.session.prompt({
        path: { id: sessionId },
        body,
      });

      const data = response?.data ?? response;
      if (typeof data === 'string') return data;

      // Extract text parts from the assistant response
      // Response shape: { info: { role, ... }, parts: [{ type, text }, ...] }
      const text = this.extractText(data);
      if (text) return text;

      return JSON.stringify(data);
    };

    // Race the work against a timeout
    const timeout = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        reject(new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs));
      }, timeoutMs);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(id);
        const err = new Error('Request was cancelled');
        err.name = 'AbortError';
        reject(err);
      });
    });

    return Promise.race([work(), timeout]);
  }

  /**
   * Extracts text content from a message-like object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractText(msg: any): string | undefined {
    if (!msg) return undefined;
    if (typeof msg === 'string') return msg;
    if (msg.text) return msg.text;
    if (msg.content && typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (part.type === 'text' && part.text) return part.text;
      }
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) return part.text;
      }
    }
    return undefined;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.session.list();
      return true;
    } catch (err) {
      logError('OpenCodeClient: availability check failed', err);
      return false;
    }
  }

  dispose(): void {
    if (serverHandle?.close) {
      try { serverHandle.close(); } catch { /* ignore */ }
    }
    clientInstance = null;
    serverHandle = null;
    sdkModule = null;
  }
}
