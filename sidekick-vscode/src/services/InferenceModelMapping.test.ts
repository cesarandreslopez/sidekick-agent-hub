import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { ApiKeyClient } from './ApiKeyClient';
import { MaxSubscriptionClient } from './MaxSubscriptionClient';

describe('inference client model mapping', () => {
  it('passes literal model IDs through the API client', () => {
    const client = Object.create(ApiKeyClient.prototype) as unknown as {
      mapModel(model?: string): string;
    };

    expect(client.mapModel('claude-sonnet-4-6-20260201')).toBe('claude-sonnet-4-6-20260201');
    expect(client.mapModel('custom-claude-compatible-model')).toBe(
      'custom-claude-compatible-model',
    );
    expect(client.mapModel(undefined)).toBe('claude-haiku-4-5');
  });

  it('passes literal model IDs through the Max client', () => {
    const client = Object.create(MaxSubscriptionClient.prototype) as unknown as {
      mapModel(model?: string): string;
    };

    expect(client.mapModel('claude-opus-4-8-20260701')).toBe('claude-opus-4-8-20260701');
    expect(client.mapModel(undefined)).toBe('haiku');
  });
});
