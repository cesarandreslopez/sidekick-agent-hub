import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { OpenCodeClient } from './OpenCodeClient';

describe('OpenCodeClient', () => {
  const clients: OpenCodeClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
  });

  it('deletes its temporary server session after a completion', async () => {
    const api = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        prompt: vi.fn(async () => ({ data: { parts: [{ type: 'text', text: 'done' }] } })),
        delete: vi.fn(async () => undefined),
      },
    };
    const client = new OpenCodeClient();
    clients.push(client);
    (client as never as { getClient: () => Promise<unknown> }).getClient = async () => api;

    await expect(client.complete('prompt')).resolves.toBe('done');
    expect(api.session.create).toHaveBeenCalledWith({
      body: {},
      signal: expect.any(AbortSignal),
    });
    expect(api.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.session.delete).toHaveBeenCalledWith({ path: { id: 'session-1' } });
  });

  it('forwards cancellation to SDK calls and still deletes the session', async () => {
    const api = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-2' } })),
        prompt: vi.fn(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
        ),
        delete: vi.fn(async () => undefined),
      },
    };
    const client = new OpenCodeClient();
    clients.push(client);
    (client as never as { getClient: () => Promise<unknown> }).getClient = async () => api;
    const controller = new AbortController();
    const pending = client.complete('prompt', { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.session.delete).toHaveBeenCalledWith({ path: { id: 'session-2' } });
  });

  it('shares one in-flight client initialization', async () => {
    let finish!: (value: unknown) => void;
    const initialized = new Promise((resolve) => {
      finish = resolve;
    });
    const client = new OpenCodeClient();
    clients.push(client);
    const internals = client as never as {
      initializeClient: () => Promise<unknown>;
      getClient: () => Promise<unknown>;
    };
    internals.initializeClient = vi.fn(() => initialized);

    const first = internals.getClient();
    const second = internals.getClient();
    finish({ connected: true });

    await expect(first).resolves.toEqual({ connected: true });
    await expect(second).resolves.toEqual({ connected: true });
    expect(internals.initializeClient).toHaveBeenCalledOnce();
  });
});
