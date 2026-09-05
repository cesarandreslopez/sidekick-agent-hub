import { afterEach, describe, it, expect } from 'vitest';
import {
  parseModelId,
  getModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  calculateCostWithProvenance,
  mergeCostSources,
  shortModelName,
  sortModelIds,
  formatCost,
  _setPricingOverrides,
  _clearPricingOverrides,
  _getPricingOverrides,
} from './modelInfo';

// Keep tests isolated from each other when they poke the override map.
afterEach(() => _clearPricingOverrides());

describe('parseModelId', () => {
  it('parses versioned Claude model IDs', () => {
    expect(parseModelId('claude-opus-4-20250514')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '4',
    });
    expect(parseModelId('claude-sonnet-4.5-20241022')).toEqual({
      provider: 'anthropic',
      family: 'sonnet',
      version: '4.5',
    });
    expect(parseModelId('claude-haiku-4.5-20251001')).toEqual({
      provider: 'anthropic',
      family: 'haiku',
      version: '4.5',
    });
  });

  it('parses hyphenated minor versions the way Anthropic writes modern IDs', () => {
    // Every shipping Anthropic ID uses hyphens, not dots. Reading the minor
    // version out of them is the whole point of the parse.
    expect(parseModelId('claude-sonnet-4-6-20260321')).toEqual({
      provider: 'anthropic',
      family: 'sonnet',
      version: '4.6',
    });
    expect(parseModelId('claude-sonnet-4-5-20250929')).toEqual({
      provider: 'anthropic',
      family: 'sonnet',
      version: '4.5',
    });
    expect(parseModelId('claude-opus-4-1-20250805')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '4.1',
    });
    expect(parseModelId('claude-haiku-4-5-20251001')).toEqual({
      provider: 'anthropic',
      family: 'haiku',
      version: '4.5',
    });
    expect(parseModelId('claude-fable-5-1')).toEqual({
      provider: 'anthropic',
      family: 'fable',
      version: '5.1',
    });
  });

  it('does not mistake the release date for a minor version', () => {
    // `claude-opus-4-20250514` has no minor version; the 8-digit suffix is a
    // date. Naively allowing `-<digits>` would read it as `4.20250514`.
    expect(parseModelId('claude-opus-4-20250514')?.version).toBe('4');
    expect(parseModelId('claude-sonnet-4-20250514')?.version).toBe('4');
    expect(parseModelId('claude-sonnet-4')?.version).toBe('4');
  });

  it('ranks hyphenated minor versions above their base version', () => {
    // versionRank feeds shortModelName/tier ordering; before the parse fix
    // 4.5 and 4.6 both read as "4" and tied.
    const four = getModelInfo('claude-sonnet-4-20250514');
    const fourFive = getModelInfo('claude-sonnet-4-5-20250929');
    const fourSix = getModelInfo('claude-sonnet-4-6-20260321');
    expect(four.version).toBe('4');
    expect(fourFive.version).toBe('4.5');
    expect(fourSix.version).toBe('4.6');
  });

  it('parses Fable model IDs', () => {
    expect(parseModelId('claude-fable-5')).toEqual({
      provider: 'anthropic',
      family: 'fable',
      version: '5',
    });
    expect(parseModelId('claude-fable-5[1m]')).toEqual({
      provider: 'anthropic',
      family: 'fable',
      version: '5',
    });
  });

  it('parses OpenAI GPT model IDs', () => {
    expect(parseModelId('gpt-4o')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '4o',
    });
    expect(parseModelId('gpt-5.4')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '5.4',
    });
    expect(parseModelId('gpt-5.3-codex')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '5.3-codex',
    });
  });

  it('parses OpenAI o-series reasoning model IDs', () => {
    expect(parseModelId('o1')).toEqual({ provider: 'openai', family: 'o', version: '1' });
    expect(parseModelId('o3')).toEqual({ provider: 'openai', family: 'o', version: '3' });
    expect(parseModelId('o3-mini')).toEqual({ provider: 'openai', family: 'o', version: '3-mini' });
    expect(parseModelId('o1-pro')).toEqual({ provider: 'openai', family: 'o', version: '1-pro' });
  });

  it('parses Gemini model IDs', () => {
    expect(parseModelId('gemini-1.5-pro')).toEqual({
      provider: 'google',
      family: 'gemini',
      version: '1.5-pro',
    });
    expect(parseModelId('gemini-2.0-flash')).toEqual({
      provider: 'google',
      family: 'gemini',
      version: '2.0-flash',
    });
  });

  it('returns null for unrecognized IDs', () => {
    expect(parseModelId('deepseek-coder')).toBeNull();
    expect(parseModelId('totally-made-up')).toBeNull();
    expect(parseModelId('')).toBeNull();
  });

  it('strips [1m] suffix before matching', () => {
    expect(parseModelId('claude-opus-4-6[1m]')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '4.6',
    });
  });

  it('parses legacy Claude model IDs with version before family', () => {
    expect(parseModelId('claude-3-opus-20240229')).toEqual({
      provider: 'anthropic',
      family: 'opus',
      version: '3',
    });
    expect(parseModelId('claude-3-5-sonnet-20241022')).toEqual({
      provider: 'anthropic',
      family: 'sonnet',
      version: '3.5',
    });
  });

  it('trims and lowercases padded or mixed-case IDs', () => {
    expect(parseModelId(' Claude-Opus-4-8 ')).toEqual(parseModelId('claude-opus-4-8'));
    expect(parseModelId('GPT-4O')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '4o',
    });
  });
});

describe('getModelPricing', () => {
  it('returns exact pricing for known Claude models', () => {
    const pricing = getModelPricing('claude-sonnet-4.5-20241022');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputCostPerMillion).toBe(3.0);
    expect(pricing!.outputCostPerMillion).toBe(15.0);
  });

  it('returns pricing for Opus 4.8 and Fable 5', () => {
    const opus48 = getModelPricing('claude-opus-4-8');
    expect(opus48).not.toBeNull();
    expect(opus48!.inputCostPerMillion).toBe(5.0);
    expect(opus48!.outputCostPerMillion).toBe(25.0);

    const fable = getModelPricing('claude-fable-5');
    expect(fable).not.toBeNull();
    expect(fable!.inputCostPerMillion).toBe(10.0);
    expect(fable!.outputCostPerMillion).toBe(50.0);
    expect(fable!.cacheWriteCostPerMillion).toBe(12.5);
    expect(fable!.cacheReadCostPerMillion).toBe(1.0);
  });

  it('prices dashed Opus 4.6/4.7 IDs at the 4.5+ tier, not the Opus 4.0 tier', () => {
    // Regression: dashed IDs used to prefix-match 'claude-opus-4' ($15/$75).
    for (const id of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-6-20251101']) {
      const pricing = getModelPricing(id);
      expect(pricing).not.toBeNull();
      expect(pricing!.inputCostPerMillion).toBe(5.0);
      expect(pricing!.outputCostPerMillion).toBe(25.0);
    }
  });

  it('keeps dashed and dotted Claude version spellings on identical pricing', () => {
    for (const [dashed, dotted] of [
      ['claude-haiku-4-5', 'claude-haiku-4.5'],
      ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
      ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
      ['claude-opus-4-5', 'claude-opus-4.5'],
      ['claude-opus-4-6', 'claude-opus-4.6'],
      ['claude-opus-4-7', 'claude-opus-4.7'],
      ['claude-opus-4-8', 'claude-opus-4.8'],
      ['claude-fable-5-1', 'claude-fable-5.1'],
    ]) {
      expect(getModelPricing(`${dashed}-20260101`)).toEqual(getModelPricing(dotted));
    }
  });

  it('prices dashed Haiku 4.5 IDs', () => {
    // Regression: 'claude-haiku-4-5-20251001' matched no static key and showed "—".
    const pricing = getModelPricing('claude-haiku-4-5-20251001');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputCostPerMillion).toBe(1.0);
    expect(pricing!.outputCostPerMillion).toBe(5.0);
  });

  it('returns pricing for known OpenAI models', () => {
    const gpt4o = getModelPricing('gpt-4o');
    expect(gpt4o).not.toBeNull();
    expect(gpt4o!.inputCostPerMillion).toBe(2.5);
    expect(gpt4o!.outputCostPerMillion).toBe(10.0);

    const o3mini = getModelPricing('o3-mini');
    expect(o3mini).not.toBeNull();
    expect(o3mini!.inputCostPerMillion).toBe(1.1);
  });

  it('matches longest-prefix for variant suffixes', () => {
    // A hypothetical fine-tune or date suffix should still resolve to the base.
    const pricing = getModelPricing('gpt-5.4-20260301');
    expect(pricing).not.toBeNull();
    expect(pricing!.outputCostPerMillion).toBe(15.0);
  });

  it('prices current Claude and GPT-5 models from the static baseline', () => {
    // Regression guard: these shipped with no static entry and resolved to
    // either null (Claude) or an older model's rate via prefix match (GPT).
    const opus5 = getModelPricing('claude-opus-5');
    expect(opus5).not.toBeNull();
    expect(opus5!.inputCostPerMillion).toBe(5.0);
    expect(opus5!.outputCostPerMillion).toBe(25.0);

    // Sonnet 5 broke the $3/$15 every earlier Sonnet charged.
    const sonnet5 = getModelPricing('claude-sonnet-5');
    expect(sonnet5).not.toBeNull();
    expect(sonnet5!.inputCostPerMillion).toBe(2.0);
    expect(sonnet5!.outputCostPerMillion).toBe(10.0);

    // gpt-5.6-sol must NOT inherit the cheaper `gpt-5` prefix entry.
    const sol = getModelPricing('gpt-5.6-sol');
    expect(sol).toEqual({
      inputCostPerMillion: 4.0,
      outputCostPerMillion: 20.0,
      cacheWriteCostPerMillion: 5.0,
      cacheReadCostPerMillion: 0.4,
    });
    expect(getModelPricing('gpt-5.6')).toEqual(sol);

    const terra = getModelPricing('gpt-5.6-terra');
    expect(terra).toEqual({
      inputCostPerMillion: 2.0,
      outputCostPerMillion: 12.0,
      cacheWriteCostPerMillion: 2.5,
      cacheReadCostPerMillion: 0.2,
    });

    // A mini variant must not inherit its full-size sibling's rate.
    const mini = getModelPricing('gpt-5.4-mini');
    expect(mini!.inputCostPerMillion).toBe(0.75);
    expect(mini!.cacheReadCostPerMillion).toBe(0.075);
  });

  it('prices GPT-5 tier variants from their own rate, not a shorter prefix key', () => {
    // Regression guard: each of these shipped with no static entry and
    // prefix-matched to a plausible-looking but wrong number.
    const luna = getModelPricing('gpt-5.6-luna');
    expect(luna).not.toBeNull();
    expect(luna!.inputCostPerMillion).toBe(0.2);
    expect(luna!.outputCostPerMillion).toBe(1.2);
    expect(luna!.cacheWriteCostPerMillion).toBe(0.25);
    expect(luna!.cacheReadCostPerMillion).toBe(0.02);

    // Luna must keep its own rate rather than inherit Sol via `gpt-5.6`.
    const sol = getModelPricing('gpt-5.6-sol');
    expect(luna!.inputCostPerMillion).not.toBe(sol!.inputCostPerMillion);
    expect(luna!.outputCostPerMillion).not.toBe(sol!.outputCostPerMillion);

    // Pro tiers cost far more than the base model they prefix-matched.
    const pro55 = getModelPricing('gpt-5.5-pro');
    expect(pro55!.inputCostPerMillion).toBe(30.0);
    expect(pro55!.outputCostPerMillion).toBe(180.0);

    const pro54 = getModelPricing('gpt-5.4-pro');
    expect(pro54!.inputCostPerMillion).toBe(30.0);
    expect(pro54!.outputCostPerMillion).toBe(180.0);

    // And a nano variant costs far less, where `gpt-5.4` charged it $2.50/$15.
    const nano = getModelPricing('gpt-5.4-nano');
    expect(nano!.inputCostPerMillion).toBe(0.2);
    expect(nano!.outputCostPerMillion).toBe(1.25);
  });

  it('prices every mini/nano/pro tier from its own rate across GPT and o-series', () => {
    // Second sweep of the same defect: a tier variant with no entry of its own
    // inherits its base model's rate. Rates verified against the LiteLLM
    // catalog's bare top-level keys.
    const cases: Array<[string, number, number]> = [
      // Cheaper than the base key they used to inherit.
      ['gpt-5-mini', 0.25, 2.0],
      ['gpt-5-nano', 0.05, 0.4],
      ['gpt-5.1-codex-mini', 0.25, 2.0],
      ['gpt-4.1-mini', 0.4, 1.6],
      ['gpt-4.1-nano', 0.1, 0.4],
      // Far more expensive than the base key they used to inherit.
      ['gpt-5-pro', 15.0, 120.0],
      ['gpt-5.2-pro', 21.0, 168.0],
      ['o1-pro', 150.0, 600.0],
      ['o3-pro', 20.0, 80.0],
      ['o3-deep-research', 10.0, 40.0],
      // Own entry, but the value itself was stale.
      ['gpt-5.3-codex', 1.75, 14.0],
      ['gpt-5.3-chat-latest', 1.75, 14.0],
      ['o1-mini', 1.1, 4.4],
      ['gpt-5.2', 1.75, 14.0],
    ];
    for (const [id, input, output] of cases) {
      const p = getModelPricing(id);
      expect(p, `${id} should be priced`).not.toBeNull();
      expect(p!.inputCostPerMillion, `${id} input`).toBe(input);
      expect(p!.outputCostPerMillion, `${id} output`).toBe(output);
    }
  });

  it('gives dated and suffixed snapshots their base model rate, not a shorter key', () => {
    // One base entry covers a model's dated snapshots for free, because the
    // longest matching key wins. These all used to fall through to `gpt-5`.
    expect(getModelPricing('gpt-5-nano-2025-08-07')!.inputCostPerMillion).toBe(0.05);
    expect(getModelPricing('gpt-5-pro-2025-10-06')!.inputCostPerMillion).toBe(15.0);
    expect(getModelPricing('gpt-4.1-mini-2025-04-14')!.inputCostPerMillion).toBe(0.4);

    // `gpt-5.2-codex` and the chat variants bill at the plain gpt-5.2 rate...
    expect(getModelPricing('gpt-5.2-codex')!.inputCostPerMillion).toBe(1.75);
    expect(getModelPricing('gpt-5.2-chat-latest')!.inputCostPerMillion).toBe(1.75);
    // ...while `-pro` must still win over the shorter `gpt-5.2` key.
    expect(getModelPricing('gpt-5.2-pro-2025-12-11')!.inputCostPerMillion).toBe(21.0);
  });

  it('keeps base models off their own tier variants rates', () => {
    // The inverse guard: adding a longer key must not capture the base model.
    expect(getModelPricing('gpt-5')!.inputCostPerMillion).toBe(1.25);
    expect(getModelPricing('gpt-4.1')!.inputCostPerMillion).toBe(2.0);
    expect(getModelPricing('o1')!.inputCostPerMillion).toBe(15.0);
    expect(getModelPricing('o3')!.inputCostPerMillion).toBe(2.0);
    expect(getModelPricing('o3-mini')!.inputCostPerMillion).toBe(1.1);
  });

  it('returns null for unknown models (no silent fallback)', () => {
    expect(getModelPricing('deepseek-coder')).toBeNull();
    expect(getModelPricing('made-up-model')).toBeNull();
    expect(getModelPricing('')).toBeNull();
  });

  it('runtime overrides take precedence over the static table', () => {
    _setPricingOverrides({
      'claude-sonnet-4.5': {
        inputCostPerMillion: 99.0,
        outputCostPerMillion: 99.0,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const pricing = getModelPricing('claude-sonnet-4.5-20241022');
    expect(pricing!.inputCostPerMillion).toBe(99.0);
  });

  it('overrides can teach us new models the static table does not know', () => {
    _setPricingOverrides({
      'mystery-model-v2': {
        inputCostPerMillion: 7,
        outputCostPerMillion: 42,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const pricing = getModelPricing('mystery-model-v2-20260101');
    expect(pricing!.outputCostPerMillion).toBe(42);
  });

  it('resolves padded or mixed-case IDs against the lowercase tables', () => {
    expect(getModelPricing('Claude-Opus-4-8 ')).toEqual(getModelPricing('claude-opus-4-8'));
    expect(getModelPricing('Claude-Opus-4-8 ')).not.toBeNull();

    const fable = getModelPricing('CLAUDE-FABLE-5[1M]');
    expect(fable).not.toBeNull();
    expect(fable!.inputCostPerMillion).toBe(10.0);
  });

  it('still matches mixed-case override keys verbatim', () => {
    // LiteLLM catalog keys are stored as published; the verbatim first-stage
    // lookup must keep matching them even when they are not lowercase.
    _setPricingOverrides({
      'MiXeD-Case-Model': {
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const pricing = getModelPricing('MiXeD-Case-Model-20260101');
    expect(pricing).not.toBeNull();
    expect(pricing!.outputCostPerMillion).toBe(2);
  });
});

describe('getModelInfo', () => {
  it('recognizes Astra with pricing and context even without a runtime catalog', () => {
    expect(getModelInfo('gpt-6-astra')).toMatchObject({
      provider: 'openai',
      family: 'gpt',
      version: '6-astra',
      contextWindow: 1_050_000,
      pricing: {
        inputCostPerMillion: 10,
        outputCostPerMillion: 50,
        cacheWriteCostPerMillion: 12.5,
        cacheReadCostPerMillion: 1,
      },
    });
  });

  it('returns full info for a Claude model', () => {
    const info = getModelInfo('claude-opus-4-20250514');
    expect(info.provider).toBe('anthropic');
    expect(info.family).toBe('opus');
    expect(info.version).toBe('4');
    expect(info.contextWindow).toBe(200_000);
    expect(info.pricing).not.toBeNull();
    expect(info.pricing!.inputCostPerMillion).toBe(15.0);
  });

  it('returns full info for a GPT model', () => {
    const info = getModelInfo('gpt-4o');
    expect(info.provider).toBe('openai');
    expect(info.family).toBe('gpt');
    expect(info.version).toBe('4o');
    expect(info.contextWindow).toBe(128_000);
    expect(info.pricing).not.toBeNull();
  });

  it('returns null provider/family for unknown models', () => {
    const info = getModelInfo('deepseek-coder');
    expect(info.provider).toBeNull();
    expect(info.family).toBeNull();
    expect(info.version).toBeNull();
    expect(info.pricing).toBeNull();
  });
});

describe('calculateCost', () => {
  it.each([
    'claude-fable-5-1',
    'claude-fable-5.1',
    'claude-fable-5-1-20260901',
    'CLAUDE-FABLE-5.1[1M]',
  ])('prices %s cache reads at the 5.1 rate while preserving Fable 5', (model) => {
    const tokens = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 800_000,
    };
    // $1.25 for writes plus $0.20 for reads, formerly $0.80 via Fable 5.
    expect(calculateCost(tokens, model)).toBeCloseTo(1.45);
    expect(calculateCost(tokens, 'claude-fable-5')).toBeCloseTo(2.05);
  });

  it('calculates cost for a Claude model', () => {
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'claude-sonnet-4-20250514',
    );
    expect(cost).toBeCloseTo(3.0, 2);
  });

  it('includes cache costs', () => {
    const cost = calculateCost(
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      'claude-sonnet-4-20250514',
    );
    // cacheWrite: 3.75, cacheRead: 0.3
    expect(cost).toBeCloseTo(4.05, 2);
  });

  it('prices reasoning tokens at the output rate', () => {
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 1_000_000,
      },
      'o3-mini',
    );
    // o3-mini output rate is $4.40/M
    expect(cost).toBeCloseTo(4.4, 2);
  });

  it('returns null for unknown models (not 0)', () => {
    const cost = calculateCost(
      { inputTokens: 100_000, outputTokens: 50_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      'totally-unknown-model',
    );
    expect(cost).toBeNull();
  });
});

describe('calculateCostWithPricing', () => {
  it('calculates using explicit pricing', () => {
    const cost = calculateCostWithPricing(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      {
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    );
    expect(cost).toBeCloseTo(18.0, 2);
  });

  it('treats reasoning tokens as output', () => {
    const cost = calculateCostWithPricing(
      {
        inputTokens: 0,
        outputTokens: 500_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 500_000,
      },
      {
        inputCostPerMillion: 0,
        outputCostPerMillion: 10,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    );
    // (0.5 + 0.5) × $10 = $10
    expect(cost).toBeCloseTo(10.0, 2);
  });

  it('handles missing reasoning field as zero', () => {
    const cost = calculateCostWithPricing(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      {
        inputCostPerMillion: 5,
        outputCostPerMillion: 15,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    );
    expect(cost).toBeCloseTo(5.0, 2);
  });
});

describe('cost provenance', () => {
  it('prefers provider-reported cost when available', () => {
    expect(
      calculateCostWithProvenance({
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
        modelId: 'claude-sonnet-4-20250514',
        reportedCostUsd: 1.23,
      }),
    ).toEqual({ costUsd: 1.23, source: 'reported' });
  });

  it('estimates known models and marks unknown models unpriced', () => {
    expect(
      calculateCostWithProvenance({
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        modelId: 'claude-sonnet-4-20250514',
      }),
    ).toEqual({ costUsd: 3, source: 'estimated' });

    expect(
      calculateCostWithProvenance({
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        modelId: 'unknown-model',
      }),
    ).toEqual({ source: 'unpriced' });
  });

  it('merges cost sources conservatively', () => {
    expect(mergeCostSources('reported', 'estimated')).toBe('estimated');
    expect(mergeCostSources('estimated', 'unpriced')).toBe('unpriced');
    expect(mergeCostSources('reported', 'reported')).toBe('reported');
  });
});

describe('model display helpers', () => {
  it('uses compact labels for legacy and modern Claude IDs', () => {
    expect(shortModelName('claude-opus-4-20250514')).toBe('Opus');
    expect(shortModelName('claude-3-sonnet-20240229')).toBe('Sonnet');
    expect(shortModelName('claude-fable-5')).toBe('Fable');
    expect(shortModelName('claude-fable-5[1m]')).toBe('Fable');
  });

  it('normalizes common OpenAI labels', () => {
    expect(shortModelName('gpt-4o-mini')).toBe('GPT-4o mini');
    expect(shortModelName('o3-mini')).toBe('o3-mini');
    expect(shortModelName('gpt-5.3-codex')).toBe('Codex');
  });

  it('sorts model ids by provider family rank', () => {
    expect(
      sortModelIds(['claude-haiku-4.5', 'gpt-4o', 'claude-opus-4.5', 'claude-sonnet-4.5']),
    ).toEqual(['claude-opus-4.5', 'claude-sonnet-4.5', 'claude-haiku-4.5', 'gpt-4o']);
  });

  it('ranks Fable above Opus', () => {
    expect(sortModelIds(['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-4-6'])).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
  });
});

describe('formatCost', () => {
  it('formats small costs with 4 decimal places', () => {
    expect(formatCost(0.001234)).toBe('$0.0012');
  });

  it('formats normal costs with 2 decimal places', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  it("renders null as '—'", () => {
    expect(formatCost(null)).toBe('—');
  });

  it("renders undefined as '—'", () => {
    expect(formatCost(undefined)).toBe('—');
  });
});

describe('override map helpers', () => {
  it('_getPricingOverrides returns a snapshot', () => {
    _setPricingOverrides({
      'x-y-z': {
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    const snap = _getPricingOverrides();
    expect(snap['x-y-z']).toBeDefined();
    // Mutating the snapshot must not affect internal state.
    delete snap['x-y-z'];
    expect(_getPricingOverrides()['x-y-z']).toBeDefined();
  });

  it('_clearPricingOverrides wipes the map', () => {
    _setPricingOverrides({
      'a-b': {
        inputCostPerMillion: 1,
        outputCostPerMillion: 1,
        cacheWriteCostPerMillion: 0,
        cacheReadCostPerMillion: 0,
      },
    });
    _clearPricingOverrides();
    expect(_getPricingOverrides()).toEqual({});
  });
});
