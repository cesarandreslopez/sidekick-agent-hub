export type TokenEstimationMethod = 'exact' | 'sidekick-fallback-v1';
export type TokenEstimationConfidence = 'exact' | 'medium' | 'low';

export interface ExactTokenCounterContext {
  model?: string;
}

export type ExactTokenCounter = (
  text: string,
  context: ExactTokenCounterContext,
) => number | null | undefined;

export interface TokenEstimationOptions extends ExactTokenCounterContext {
  exactCounter?: ExactTokenCounter;
}

export interface TokenEstimate {
  count: number;
  method: TokenEstimationMethod;
  confidence: TokenEstimationConfidence;
  provenance: string;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Estimate tokens without bundling a tokenizer.
 *
 * Fallback v1 counts Latin/source-code runs at 3.5 UTF-16 characters per
 * token, CJK code points at one token, emoji at two, and other non-ASCII code
 * points at one. The result is deliberately conservative for context budgets.
 */
export function estimateTextTokens(
  text: string,
  options: TokenEstimationOptions = {},
): TokenEstimate {
  if (text.length === 0) {
    return { count: 0, method: 'sidekick-fallback-v1', confidence: 'medium', provenance: 'empty' };
  }

  let exact: number | null | undefined;
  try {
    exact = options.exactCounter?.(text, { model: options.model });
  } catch {
    exact = undefined;
  }
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) {
    return {
      count: Math.ceil(exact),
      method: 'exact',
      confidence: 'exact',
      provenance: options.model ?? 'injected-counter',
    };
  }

  let asciiChars = 0;
  let conservativeTokens = 0;
  for (const codePoint of text) {
    if (EMOJI.test(codePoint)) conservativeTokens += 2;
    else if (CJK.test(codePoint)) conservativeTokens += 1;
    else if ((codePoint.codePointAt(0) ?? 128) <= 127) asciiChars += codePoint.length;
    else conservativeTokens += 1;
  }
  const count = Math.ceil(asciiChars / 3.5) + conservativeTokens;
  return {
    count: Number.isFinite(count) && count >= 0 ? count : 0,
    method: 'sidekick-fallback-v1',
    confidence: conservativeTokens > 0 ? 'low' : 'medium',
    provenance: 'chars-per-token-3.5+cjk1+emoji2',
  };
}

export function estimateSerializedTokens(
  value: unknown,
  options: TokenEstimationOptions = {},
): TokenEstimate {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    serialized = String(value);
  }
  return estimateTextTokens(serialized, options);
}
