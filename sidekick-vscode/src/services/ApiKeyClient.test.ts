import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('ApiKeyClient per-model request settings', () => {
  beforeEach(() => create.mockReset());
  const reply = (stop_reason = 'end_turn') => ({
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'done' },
    ],
    stop_reason,
  });

  it('turns Haiku 5.5 thinking off for a minimal-effort feature', async () => {
    create.mockResolvedValueOnce(reply());
    await expect(
      new ApiKeyClient('k').complete('p', { model: 'haiku', maxTokens: 200, effort: 'minimal' }),
    ).resolves.toBe('done');
    expect(create.mock.calls[0][0]).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'p' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
  });

  it('uses between_tools for Sonnet 5.5 and effort plus headroom for Opus 5.5', async () => {
    create.mockResolvedValue(reply());
    await new ApiKeyClient('k').complete('p', {
      model: 'sonnet',
      maxTokens: 100,
      effort: 'minimal',
    });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'between_tools' },
    });
    await new ApiKeyClient('k').complete('p', { model: 'opus', maxTokens: 2000, effort: 'medium' });
    expect(create.mock.calls[1][0]).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 10_192,
      output_config: { effort: 'medium' },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty('thinking');
  });

  it('sends Claude 4.x models no new fields and never a sampling parameter', async () => {
    create.mockResolvedValue(reply());
    await new ApiKeyClient('k').complete('p', { model: 'claude-haiku-4-5', effort: 'minimal' });
    expect(create.mock.calls[0][0]).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'p' }],
    });
    for (const [body] of create.mock.calls) {
      expect(JSON.stringify(body)).not.toMatch(/temperature|top_p|top_k|budget_tokens/);
    }
  });

  it('reports a refusal instead of an empty completion', async () => {
    create.mockResolvedValueOnce({ content: [], stop_reason: 'refusal' });
    await expect(new ApiKeyClient('k').complete('p', { effort: 'low' })).rejects.toThrow(
      /declined/,
    );
  });

  it('checks availability on the fast tier with thinking off', async () => {
    create.mockResolvedValueOnce(reply());
    await new ApiKeyClient('k').isAvailable();
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      thinking: { type: 'disabled' },
    });
  });
});
