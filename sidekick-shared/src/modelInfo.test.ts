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
  compareModelIds,
  formatCost,
  canonicalModelId,
  isMovingModelAlias,
  registerModelPricing,
  clearRegisteredModelPricing,
  resolveModelPricing,
  getPricingCatalogInfo,
  costSourceFromPricingProvenance,
  mergeCostComponents,
  _setPricingOverrides,
  _clearPricingOverrides,
  _getPricingOverrides,
  _clearImportedResolvedPricing,
  _getModelPricingIds,
  type ModelPricing,
} from './modelInfo';
import { formatCost as formattingFormatCost } from './formatting';
import { exportResolvedModelCatalog, importResolvedModelCatalog } from './modelCatalog';
import { _clearModelAliases, registerModelAlias } from './modelAliases';

// Keep tests isolated from each other when they poke the pricing layers.
afterEach(() => {
  _clearPricingOverrides();
  _clearImportedResolvedPricing();
  clearRegisteredModelPricing();
  _clearModelAliases();
});

function rates(input: number, output = input * 5): ModelPricing {
  return {
    inputCostPerMillion: input,
    outputCostPerMillion: output,
    cacheWriteCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
  };
}

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
      ['claude-opus-5-5', 'claude-opus-5.5'],
    ]) {
      expect(getModelPricing(`${dashed}-20260101`)).toEqual(getModelPricing(dotted));
    }
  });

  it('prices GPT-6 Sol and Luna on their own rates', () => {
    expect(getModelPricing('gpt-6-sol')).toEqual({
      inputCostPerMillion: 2.0,
      outputCostPerMillion: 10.0,
      cacheWriteCostPerMillion: 2.5,
      cacheReadCostPerMillion: 0.2,
    });
    expect(getModelPricing('gpt-6-luna')).toEqual({
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.5,
      cacheWriteCostPerMillion: 0.125,
      cacheReadCostPerMillion: 0.01,
    });
    expect(getModelInfo('gpt-6-sol').contextWindow).toBe(1_050_000);
    expect(getModelInfo('gpt-6-luna').contextWindow).toBe(1_050_000);
  });

  it('prices Opus 5.5 on its own rates rather than the Opus 5 prefix', () => {
    const pricing = getModelPricing('claude-opus-5-5');
    expect(pricing).toEqual({
      inputCostPerMillion: 4.0,
      outputCostPerMillion: 20.0,
      cacheWriteCostPerMillion: 5.0,
      cacheReadCostPerMillion: 0.2,
    });
    expect(getModelPricing('claude-opus-5')!.inputCostPerMillion).toBe(5.0);
    expect(getModelInfo('claude-opus-5-5').contextWindow).toBe(1_000_000);
    expect(shortModelName('claude-opus-5-5')).toBe(shortModelName('claude-opus-5.5'));
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

describe('canonicalModelId', () => {
  it.each([
    // Case, whitespace, and the 1M-context marker.
    [' Claude-Opus-4-8 ', 'claude-opus-4-8'],
    ['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'],
    ['CLAUDE-FABLE-5[1M]', 'claude-fable-5'],
    // Every leading provider/region segment.
    ['openai/gpt-6.1-sol', 'gpt-6.1-sol'],
    ['anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['azure/us/gpt-6.1-terra', 'gpt-6.1-terra'],
    ['openrouter/anthropic/claude-opus-5-5', 'claude-opus-5-5'],
    ['z-ai/glm-5.3', 'glm-5.3'],
    // Bedrock forms, with and without a cross-region prefix.
    ['us.anthropic.claude-opus-5-5-20261001-v1:0', 'claude-opus-5-5'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['apac.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
    ['global.anthropic.claude-sonnet-4-20250514-v1:0', 'claude-sonnet-4'],
    ['anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
    ['bedrock/us.anthropic.claude-opus-5-5-20261001-v1:0', 'claude-opus-5-5'],
    // Legacy Bedrock names keep the revision that names the model.
    ['anthropic.claude-v2:1', 'claude-v2:1'],
    ['anthropic.claude-instant-v1', 'claude-instant-v1'],
    // Vertex version pins.
    ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
    ['vertex_ai/claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
    // Date and moving suffixes.
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['gpt-6.1-sol-2026-09-29', 'gpt-6.1-sol'],
    ['gpt-4o-2024-05-13', 'gpt-4o'],
    ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet'],
    ['gpt-5.3-chat-latest', 'gpt-5.3-chat'],
    ['some-model-20250101-latest', 'some-model'],
    // Meaningful suffixes survive.
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['gpt-5.3-codex', 'gpt-5.3-codex'],
    ['gpt-6-sol', 'gpt-6-sol'],
    ['gpt-6.1-terra', 'gpt-6.1-terra'],
    ['gpt-6-luna-2026-01-01', 'gpt-6-luna'],
    ['gpt-6-astra', 'gpt-6-astra'],
    ['gpt-5-codex-high', 'gpt-5-codex-high'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    // Degenerate input.
    ['', ''],
    ['   ', ''],
    ['openai/', 'openai/'],
  ])('%j → %j', (input, expected) => {
    expect(canonicalModelId(input)).toBe(expected);
  });

  it('does not apply registered aliases', () => {
    registerModelAlias('house-model', 'claude-opus-5-5');
    expect(canonicalModelId('house-model')).toBe('house-model');
  });

  it('does not change what pricing lookups resolve', () => {
    // Deployment-prefixed ids stay unpriced: their bills can differ from the
    // direct provider's, so only an explicit table entry may price them.
    expect(getModelPricing('us.anthropic.claude-opus-5-5-20261001-v1:0')).toBeNull();
    expect(getModelPricing('azure/us/gpt-6.1-terra')).toBeNull();
    // A pinned snapshot keeps its own rate rather than the canonical model's.
    expect(getModelPricing('gpt-4o-2024-05-13')!.inputCostPerMillion).toBe(5);
    expect(resolveModelPricing('claude-opus-4-5-20251101').provenance).toMatchObject({
      source: 'static',
      match: 'prefix',
      matchedModelId: 'claude-opus-4-5',
    });
    // The resolver's own canonicalModelId field keeps its meaning.
    expect(resolveModelPricing('Claude-Opus-4-5-20251101').canonicalModelId).toBe(
      'claude-opus-4-5-20251101',
    );
  });
});

describe('isMovingModelAlias', () => {
  it.each([
    'default',
    'auto',
    'latest',
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'opusplan',
    ' Sonnet ',
    'OPUS',
    'sonnet[1m]',
    'Opus[1M]',
  ])('treats %j as a moving alias', (id) => {
    expect(isMovingModelAlias(id)).toBe(true);
  });

  it.each([
    'claude-sonnet-4-5',
    'claude-opus-5-5-20261001',
    'gpt-6-sol',
    'sonnet-4',
    'anthropic/sonnet',
    'defaults',
    'constructor',
    '__proto__',
    '',
  ])('treats %j as a concrete id', (id) => {
    expect(isMovingModelAlias(id)).toBe(false);
  });
});

describe('GPT tier variants', () => {
  it('reports the tier as variant and keeps every existing field', () => {
    expect(parseModelId('gpt-6.1-sol')).toEqual({
      provider: 'openai',
      family: 'gpt',
      version: '6.1-sol',
      variant: 'sol',
    });
    expect(parseModelId('gpt-6-luna')).toMatchObject({ version: '6-luna', variant: 'luna' });
    expect(parseModelId('gpt-6-astra')).toMatchObject({ version: '6-astra', variant: 'astra' });
    expect(parseModelId('gpt-6.1-terra-2026-09-29')).toMatchObject({
      version: '6.1-terra-2026-09-29',
      variant: 'terra',
    });
    expect(parseModelId('GPT-5.6-Terra')).toMatchObject({ version: '5.6-terra', variant: 'terra' });
  });

  it('adds no variant key to untiered ids', () => {
    for (const id of [
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-4o',
      'gpt-6',
      'gpt-6-solar',
      'o3-mini',
      'claude-sonnet-5',
      'gemini-4-argon',
    ]) {
      const parsed = parseModelId(id);
      expect(parsed, id).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(parsed, 'variant'), id).toBe(false);
    }
  });

  it('ranks variants astra > sol > terra > luna within a version, newest version first', () => {
    expect(sortModelIds(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-terra', 'gpt-6-sol'])).toEqual([
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-terra',
      'gpt-6-luna',
    ]);
    expect(
      sortModelIds([
        'gpt-6.1-terra',
        'gpt-6.1-luna',
        'gpt-6.1-astra',
        'gpt-6.1-sol',
        'gpt-6-astra',
      ]),
    ).toEqual(['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.1-luna', 'gpt-6-astra']);
    expect(compareModelIds('gpt-5.6-luna', 'gpt-5.6-sol')).toBeGreaterThan(0);
  });

  it('leaves orderings that do not compare two variants unchanged', () => {
    // Untiered vs tiered of the same version: plain id order, as before.
    expect(sortModelIds(['gpt-6-sol', 'gpt-6'])).toEqual(['gpt-6', 'gpt-6-sol']);
    // Same variant: plain id order.
    expect(sortModelIds(['gpt-6-sol-2026-09-29', 'gpt-6-sol'])).toEqual([
      'gpt-6-sol',
      'gpt-6-sol-2026-09-29',
    ]);
    // Codex ids share one rank across versions; variants only reorder within a version.
    expect(sortModelIds(['gpt-6-sol-codex', 'gpt-6.1-luna-codex'])).toEqual([
      'gpt-6-sol-codex',
      'gpt-6.1-luna-codex',
    ]);
    expect(sortModelIds(['gpt-6-luna-codex', 'gpt-6-sol-codex'])).toEqual([
      'gpt-6-sol-codex',
      'gpt-6-luna-codex',
    ]);
  });
});

describe('registerModelPricing', () => {
  it('wins over static, catalog, and imported prices by default', () => {
    registerModelPricing({ 'claude-opus-5-5': rates(1, 2) });
    expect(resolveModelPricing('claude-opus-5-5')).toMatchObject({
      pricing: rates(1, 2),
      provenance: {
        source: 'registered',
        match: 'exact',
        matchedModelId: 'claude-opus-5-5',
        inheritedByPrefix: false,
      },
    });

    _setPricingOverrides({ 'claude-opus-5-5': rates(9) });
    expect(getModelPricing('claude-opus-5-5')).toEqual(rates(1, 2));

    const snapshot = JSON.parse(
      JSON.stringify(exportResolvedModelCatalog(['claude-opus-5-5', 'gpt-6-sol'])),
    );
    snapshot.models['claude-opus-5-5'].pricing.pricing = rates(7);
    snapshot.models['claude-opus-5-5'].pricing.provenance = {
      source: 'imported',
      match: 'exact',
      inheritedByPrefix: false,
    };
    importResolvedModelCatalog(snapshot);
    expect(getModelPricing('claude-opus-5-5')).toEqual(rates(1, 2));
  });

  it('survives every reset of the catalog and imported layers', () => {
    registerModelPricing({ 'house-model-1': rates(3) });
    _setPricingOverrides({ 'gpt-4o': rates(1) });
    _setPricingOverrides({});
    _clearPricingOverrides();
    _clearImportedResolvedPricing();
    expect(getModelPricing('house-model-1')).toEqual(rates(3));

    clearRegisteredModelPricing();
    expect(getModelPricing('house-model-1')).toBeNull();
  });

  it('matches canonical forms exactly, never by prefix', () => {
    registerModelPricing({ 'claude-opus-5-5': rates(1) });
    for (const id of [
      'Claude-Opus-5-5',
      'claude-opus-5-5[1m]',
      'claude-opus-5-5-20261001',
      'us.anthropic.claude-opus-5-5-20261001-v1:0',
      'anthropic/claude-opus-5-5',
      'claude-opus-5-5@20261001',
    ]) {
      expect(resolveModelPricing(id).provenance.source, id).toBe('registered');
    }
    // A longer, different model id is not answered by a shorter key.
    expect(resolveModelPricing('claude-opus-5-5-thinking').provenance.source).toBe('static');

    registerModelPricing({ 'claude-opus-5': rates(2) });
    expect(getModelPricing('claude-opus-5-5')).toEqual(rates(1));
    expect(getModelPricing('claude-opus-5-1')).toEqual(getModelPricing('claude-opus-5-1-x'));
    expect(resolveModelPricing('claude-opus-5-1').provenance.source).toBe('static');
  });

  it('prefers the most specific registered key', () => {
    registerModelPricing({
      'azure/us/gpt-6.1-terra': rates(4),
      'gpt-6.1-terra': rates(2),
    });
    expect(getModelPricing('azure/us/gpt-6.1-terra')).toEqual(rates(4));
    expect(getModelPricing('azure/eu/gpt-6.1-terra')).toEqual(rates(2));
  });

  it('follows registered aliases', () => {
    registerModelPricing({ 'claude-opus-5-5': rates(1) });
    registerModelAlias('house-opus', 'claude-opus-5-5');
    expect(resolveModelPricing('house-opus').provenance).toMatchObject({
      source: 'registered',
      matchedModelId: 'claude-opus-5-5',
    });
  });

  describe('onlyIfMissing', () => {
    it('never replaces an exact static, catalog, or imported price', () => {
      registerModelPricing(
        { 'claude-opus-5-5': rates(1), 'gpt-4o': rates(1), 'house-x': rates(1) },
        { onlyIfMissing: true },
      );
      expect(resolveModelPricing('claude-opus-5-5').provenance).toMatchObject({
        source: 'static',
        match: 'exact',
      });

      _setPricingOverrides({ 'gpt-4o': rates(8) });
      expect(getModelPricing('gpt-4o')).toEqual(rates(8));

      const snapshot = JSON.parse(JSON.stringify(exportResolvedModelCatalog(['claude-opus-5'])));
      snapshot.models['house-x'] = {
        ...snapshot.models['claude-opus-5'],
        id: 'house-x',
        canonicalId: 'house-x',
      };
      importResolvedModelCatalog(snapshot);
      expect(resolveModelPricing('house-x').provenance.source).toBe('static');
      expect(getModelPricing('house-x')).toEqual(getModelPricing('claude-opus-5'));
    });

    it('replaces prefix-inherited and missing prices', () => {
      registerModelPricing(
        { 'gpt-5.6-unlisted': rates(6), 'claude-opus-5-5': rates(1), 'gpt-9': rates(9) },
        { onlyIfMissing: true },
      );
      // Would otherwise inherit `gpt-5.6` by prefix.
      expect(resolveModelPricing('gpt-5.6-unlisted')).toMatchObject({
        pricing: rates(6),
        provenance: { source: 'registered', match: 'exact' },
      });
      // A dated snapshot only has a prefix-inherited price of its own.
      expect(resolveModelPricing('claude-opus-5-5-20261001').provenance.source).toBe('registered');
      // Deployment forms have no price at all without it.
      expect(getModelPricing('us.anthropic.claude-opus-5-5-20261001-v1:0')).toEqual(rates(1));
      expect(getModelPricing('gpt-9')).toEqual(rates(9));
    });

    it('re-registering a key replaces its mode', () => {
      registerModelPricing({ 'claude-opus-5-5': rates(1) }, { onlyIfMissing: true });
      expect(resolveModelPricing('claude-opus-5-5').provenance.source).toBe('static');
      registerModelPricing({ 'claude-opus-5-5': rates(1) });
      expect(resolveModelPricing('claude-opus-5-5').provenance.source).toBe('registered');
    });
  });

  it('normalizes keys and skips invalid entries', () => {
    registerModelPricing({
      '  House-Model[1M] ': rates(2),
      'bad-nan': rates(Number.NaN),
      'bad-negative': rates(-1),
      'bad-missing': { inputCostPerMillion: 1, outputCostPerMillion: 1 } as ModelPricing,
      '': rates(1),
    });
    expect(getModelPricing('house-model')).toEqual(rates(2));
    expect(getModelPricing('bad-nan')).toBeNull();
    expect(getModelPricing('bad-negative')).toBeNull();
    expect(getModelPricing('bad-missing')).toBeNull();
    expect(getPricingCatalogInfo().registeredEntries).toBe(1);
  });

  it('stores copies and keeps prototype-like keys as data', () => {
    const entry = rates(2);
    registerModelPricing(
      JSON.parse(
        '{"__proto__": {"inputCostPerMillion": 1, "outputCostPerMillion": 1, "cacheWriteCostPerMillion": 0, "cacheReadCostPerMillion": 0}}',
      ),
    );
    registerModelPricing({ 'copy-check': entry });
    entry.inputCostPerMillion = 99;
    expect(getModelPricing('copy-check')!.inputCostPerMillion).toBe(2);
    getModelPricing('copy-check')!.inputCostPerMillion = 50;
    expect(getModelPricing('copy-check')!.inputCostPerMillion).toBe(2);
    expect(getModelPricing('__proto__')).toEqual(rates(1, 1));
    expect(getPricingCatalogInfo().registeredEntries).toBe(2);
  });

  it('can be bypassed to see the package layers', () => {
    registerModelPricing({ 'claude-opus-5-5': rates(1) });
    expect(
      resolveModelPricing('claude-opus-5-5', { includeRegistered: false }).provenance.source,
    ).toBe('static');
  });

  it('stays out of the catalog id enumeration', () => {
    registerModelPricing({ 'house-only-model': rates(1) });
    expect(_getModelPricingIds()).not.toContain('house-only-model');
  });

  it('feeds every cost calculation', () => {
    registerModelPricing({ 'claude-sonnet-5': rates(1, 1) });
    expect(
      calculateCost(
        { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        'claude-sonnet-5',
      ),
    ).toBe(1);
  });
});

describe('getPricingCatalogInfo', () => {
  it('describes the built-in baseline by default', () => {
    const info = getPricingCatalogInfo();
    expect(info).toEqual({
      source: 'static',
      digest: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/),
      catalogEntries: 0,
      registeredEntries: 0,
    });
    expect(info).not.toHaveProperty('fetchedAt');
  });

  it('keeps the digest stable across calls and table round-trips', () => {
    const baseline = getPricingCatalogInfo().digest;
    expect(getPricingCatalogInfo().digest).toBe(baseline);

    _setPricingOverrides({ 'gpt-4o': rates(2.5, 10) });
    const withCatalog = getPricingCatalogInfo().digest;
    expect(withCatalog).not.toBe(baseline);
    // Key order and case do not matter; content does.
    _setPricingOverrides({ 'GPT-4O': rates(2.5, 10) });
    expect(getPricingCatalogInfo().digest).toBe(withCatalog);

    _clearPricingOverrides();
    expect(getPricingCatalogInfo().digest).toBe(baseline);
  });

  it('changes the digest when any single price changes', () => {
    _setPricingOverrides({ a: rates(1), b: rates(2) });
    const before = getPricingCatalogInfo().digest;
    _setPricingOverrides({ a: rates(1), b: { ...rates(2), cacheReadCostPerMillion: 0.01 } });
    expect(getPricingCatalogInfo().digest).not.toBe(before);
  });

  it('tracks the registered layer in the digest and count', () => {
    const baseline = getPricingCatalogInfo().digest;
    registerModelPricing({ 'house-model': rates(1) });
    const registered = getPricingCatalogInfo();
    expect(registered.registeredEntries).toBe(1);
    expect(registered.source).toBe('static');
    expect(registered.digest).not.toBe(baseline);

    registerModelPricing({ 'house-model': rates(1) }, { onlyIfMissing: true });
    expect(getPricingCatalogInfo().digest).not.toBe(registered.digest);

    clearRegisteredModelPricing();
    expect(getPricingCatalogInfo()).toMatchObject({ digest: baseline, registeredEntries: 0 });
  });

  it('reports the catalog basis recorded with the overrides', () => {
    _setPricingOverrides({ 'gpt-4o': rates(1) });
    expect(getPricingCatalogInfo()).toMatchObject({ source: 'litellm', catalogEntries: 1 });
    expect(getPricingCatalogInfo()).not.toHaveProperty('fetchedAt');

    _setPricingOverrides(
      { 'gpt-4o': rates(1) },
      { source: 'stale-cache', fetchedAt: '2026-01-01T00:00:00.000Z' },
    );
    expect(getPricingCatalogInfo()).toMatchObject({
      source: 'stale-cache',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });

    // An empty catalog is no catalog, whatever basis came with it.
    _setPricingOverrides({}, { source: 'litellm', fetchedAt: '2026-01-01T00:00:00.000Z' });
    expect(getPricingCatalogInfo()).toMatchObject({ source: 'static', catalogEntries: 0 });
    expect(getPricingCatalogInfo()).not.toHaveProperty('fetchedAt');
  });

  it('reports imported resolutions when no catalog is loaded', () => {
    const baseline = getPricingCatalogInfo().digest;
    importResolvedModelCatalog(
      JSON.parse(JSON.stringify(exportResolvedModelCatalog(['gpt-6-sol']))),
    );
    const imported = getPricingCatalogInfo();
    expect(imported.source).toBe('imported');
    expect(imported.digest).not.toBe(baseline);

    _setPricingOverrides({ 'gpt-4o': rates(1) });
    expect(getPricingCatalogInfo().source).toBe('litellm');

    _clearPricingOverrides();
    _clearImportedResolvedPricing();
    expect(getPricingCatalogInfo()).toMatchObject({ source: 'static', digest: baseline });
  });
});

describe('cost source helpers', () => {
  it('maps pricing provenance to cost sources', () => {
    expect(costSourceFromPricingProvenance('provider-reported')).toBe('reported');
    expect(costSourceFromPricingProvenance('explicit-pricing')).toBe('estimated');
    expect(costSourceFromPricingProvenance('model-catalog')).toBe('estimated');
    expect(costSourceFromPricingProvenance('unpriced')).toBe('unpriced');
  });

  it('merges components with the least certain source winning', () => {
    expect(
      mergeCostComponents([
        { source: 'reported', tokens: 10 },
        { source: 'estimated', tokens: 5 },
      ]),
    ).toBe('estimated');
    expect(
      mergeCostComponents([
        { source: 'reported', tokens: 10 },
        { source: 'unpriced', tokens: 1 },
        { source: 'estimated', tokens: 5 },
      ]),
    ).toBe('unpriced');
    expect(mergeCostComponents([{ source: 'reported', tokens: 0 }])).toBe('reported');
  });

  it('ignores unseen components and token-free unpriced ones', () => {
    expect(mergeCostComponents([])).toBeUndefined();
    expect(mergeCostComponents([{ tokens: 100 }])).toBeUndefined();
    expect(mergeCostComponents([{ source: 'unpriced', tokens: 0 }])).toBeUndefined();
    expect(
      mergeCostComponents([
        { source: 'unpriced', tokens: 0 },
        { tokens: 50 },
        { source: 'reported', tokens: 50 },
      ]),
    ).toBe('reported');
    expect(mergeCostComponents([{ source: 'unpriced', tokens: Number.NaN }])).toBeUndefined();
  });

  it('accepts any iterable', () => {
    function* parts() {
      yield { source: 'estimated' as const, tokens: 1 };
      yield { source: 'reported' as const, tokens: 1 };
    }
    expect(mergeCostComponents(parts())).toBe('estimated');
    expect(mergeCostComponents(new Set([{ source: 'reported' as const, tokens: 1 }]))).toBe(
      'reported',
    );
  });
});

describe('formatCost compatibility', () => {
  it('is the formatting module implementation', () => {
    expect(formatCost).toBe(formattingFormatCost);
  });

  it('keeps shortModelName labels for canonical forms', () => {
    expect(shortModelName('us.anthropic.claude-opus-5-5-20261001-v1:0')).toBe('Opus');
    expect(shortModelName('openrouter/anthropic/claude-sonnet-4.5')).toBe('Sonnet');
    expect(shortModelName('gpt-6.1-sol-2026-09-29')).toBe('GPT-6.1-sol');
    expect(shortModelName('gpt-5.4-20260301')).toBe('GPT-5.4');
    expect(shortModelName('openai/gpt-5.3-codex')).toBe('Codex');
    expect(shortModelName('mystery-model')).toBe('mystery-model');
  });
});
