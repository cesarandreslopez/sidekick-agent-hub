import { describe, expect, it, vi } from 'vitest';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));
import { ApiKeyClient } from './ApiKeyClient';
describe('ApiKeyClient availability evidence', () => {
  it.each([401, 503])('retains the actual HTTP %s failure', async (status) => {
    const error = {
      status,
      error: { type: status === 401 ? 'authentication_error' : 'api_error' },
    };
    create.mockRejectedValueOnce(error);
    await expect(new ApiKeyClient('test-key').isAvailable()).rejects.toBe(error);
  });
});
