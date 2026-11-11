import { describe, expect, it } from 'vitest';
import { anthropicRequestTuning, openAiReasoningEffort } from './inferenceTuning';

describe('anthropicRequestTuning', () => {
  it('turns thinking off where the model allows it, at low effort', () => {
    expect(
      anthropicRequestTuning('claude-haiku-5-5', { effort: 'minimal', maxTokens: 200 }),
    ).toEqual({
      body: { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
      maxTokens: 200,
    });
    // Sonnet 5.5 rejects `disabled`; `between_tools` is its off switch.
    expect(
      anthropicRequestTuning('claude-sonnet-5-5-20261001', { effort: 'minimal', maxTokens: 200 }),
    ).toEqual({
      body: { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } },
      maxTokens: 200,
    });
    for (const id of ['claude-sonnet-5', 'claude-opus-5']) {
      expect(
        anthropicRequestTuning(id, { effort: 'minimal', maxTokens: 200 }).body.thinking,
      ).toEqual({ type: 'disabled' });
    }
  });

  it('leaves thinking on with headroom where it cannot be disabled', () => {
    for (const id of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-mythos-5-2', 'fable']) {
      const tuning = anthropicRequestTuning(id, { effort: 'minimal', maxTokens: 1024 });
      if (id === 'fable') {
        // A bare alias names no version: nothing is assumed about it.
        expect(tuning).toEqual({ body: {}, maxTokens: 1024 });
        continue;
      }
      expect(tuning.body.thinking, id).toBeUndefined();
      expect(tuning.body.output_config, id).toEqual({ effort: 'low' });
      expect(tuning.maxTokens, id).toBe(1024 + 2048);
    }
  });

  it('maps low and medium effort, capping the headroom', () => {
    expect(anthropicRequestTuning('claude-haiku-5-5', { effort: 'low', maxTokens: 500 })).toEqual({
      body: { output_config: { effort: 'low' } },
      maxTokens: 2548,
    });
    expect(
      anthropicRequestTuning('claude-opus-5-5', { effort: 'medium', maxTokens: 4096 }),
    ).toEqual({ body: { output_config: { effort: 'medium' } }, maxTokens: 12_288 });
    expect(
      anthropicRequestTuning('claude-opus-5-5', { effort: 'medium', maxTokens: 15_000 }).maxTokens,
    ).toBe(16_000);
    // Never below what was asked for.
    expect(
      anthropicRequestTuning('claude-opus-5-5', { effort: 'medium', maxTokens: 32_000 }).maxTokens,
    ).toBe(32_000);
  });

  it('sends nothing extra to models that predate effort', () => {
    for (const id of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'gpt-6-luna',
      'mystery-model',
    ]) {
      expect(anthropicRequestTuning(id, { effort: 'minimal', maxTokens: 300 }), id).toEqual({
        body: {},
        maxTokens: 300,
      });
    }
  });

  it('never produces sampling or budget parameters', () => {
    for (const id of [
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-2',
    ]) {
      for (const effort of ['minimal', 'low', 'medium'] as const) {
        const body = JSON.stringify(anthropicRequestTuning(id, { effort, maxTokens: 100 }).body);
        expect(body).not.toMatch(/temperature|top_p|top_k|budget_tokens/);
      }
    }
  });
});

describe('openAiReasoningEffort', () => {
  it('uses none where the model accepts it', () => {
    for (const id of [
      'gpt-6-luna',
      'gpt-6-sol',
      'gpt-6.1-terra',
      'gpt-5.6-sol',
      'gpt-5.4-mini',
      'gpt-5.1',
    ]) {
      expect(openAiReasoningEffort(id, 'minimal'), id).toBe('none');
    }
    expect(openAiReasoningEffort('openai/gpt-6-luna', 'minimal')).toBe('none');
  });

  it('falls back to minimal or low where none is rejected', () => {
    expect(openAiReasoningEffort('gpt-5-mini', 'minimal')).toBe('minimal');
    for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-rosalind', 'gpt-5.5-pro', 'unknown']) {
      expect(openAiReasoningEffort(id, 'minimal'), id).toBe('low');
    }
  });

  it('passes low and medium through', () => {
    expect(openAiReasoningEffort('gpt-6-luna', 'low')).toBe('low');
    expect(openAiReasoningEffort('gpt-6-astra', 'medium')).toBe('medium');
  });
});
