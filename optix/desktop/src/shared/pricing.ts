// Per-model pricing + cost estimation. Lifted out of audit.ts so the
// chat-history module can compute Ask-mode costs from the same source
// of truth — keeping the rate table in one place avoids drift when
// providers change their prices.
//
// All rates are USD per million tokens. Cache rates default to
// `input × 1.25` (write, 5-min cache) and `input × 0.10` (read) when
// not explicitly declared, mirroring Anthropic's published multipliers.

import type { TokenUsage } from './schemas';

type ModelPricing = {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWriteUsdPerMtok?: number;
  cacheReadUsdPerMtok?: number;
  /** Anthropic 1M-context tier: when a turn's input + cache tokens
   *  exceed `thresholdTokens`, that turn is billed at the long-context
   *  rates. Per-turn check, not aggregate. */
  longContext?: {
    thresholdTokens: number;
    inputUsdPerMtok: number;
    outputUsdPerMtok: number;
    cacheWriteUsdPerMtok?: number;
    cacheReadUsdPerMtok?: number;
  };
};

const PRICING: Record<string, ModelPricing> = {
  // --- Anthropic ---
  'claude-opus-4-7': {
    inputUsdPerMtok: 15,
    outputUsdPerMtok: 75,
    cacheWriteUsdPerMtok: 18.75,
    cacheReadUsdPerMtok: 1.5,
    longContext: {
      thresholdTokens: 200_000,
      inputUsdPerMtok: 30,
      outputUsdPerMtok: 150,
      cacheWriteUsdPerMtok: 37.5,
      cacheReadUsdPerMtok: 3,
    },
  },
  'claude-sonnet-4-6': {
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheWriteUsdPerMtok: 3.75,
    cacheReadUsdPerMtok: 0.3,
    longContext: {
      thresholdTokens: 200_000,
      inputUsdPerMtok: 6,
      outputUsdPerMtok: 22.5,
      cacheWriteUsdPerMtok: 7.5,
      cacheReadUsdPerMtok: 0.6,
    },
  },
  'claude-haiku-4-5': {
    inputUsdPerMtok: 1,
    outputUsdPerMtok: 5,
    cacheWriteUsdPerMtok: 1.25,
    cacheReadUsdPerMtok: 0.1,
  },
};

/** Resolve a (possibly dated/snapshot) model ID via longest-prefix
 *  match — e.g. `claude-opus-4-7-20250115` → `claude-opus-4-7`. */
function resolvePricing(modelId: string): ModelPricing | null {
  if (PRICING[modelId]) return PRICING[modelId];
  let best: { key: string; price: ModelPricing } | null = null;
  for (const [key, price] of Object.entries(PRICING)) {
    if (modelId.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

/** Cost of one turn in USD. Returns 0 for unknown models so the UI
 *  can still display SOMETHING rather than crash; callers that want
 *  to flag unknowns can check `resolvePricing` first. */
export function costForTurn(modelId: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const price = resolvePricing(modelId);
  if (!price) return 0;
  const inputTok = usage.inputTokens ?? 0;
  const outputTok = usage.outputTokens ?? 0;
  const cwTok = usage.cacheCreationInputTokens ?? 0;
  const crTok = usage.cacheReadInputTokens ?? 0;

  const totalContextTokens = inputTok + crTok + cwTok;
  const long =
    price.longContext &&
    totalContextTokens > price.longContext.thresholdTokens
      ? price.longContext
      : null;

  const ir = long?.inputUsdPerMtok ?? price.inputUsdPerMtok;
  const or = long?.outputUsdPerMtok ?? price.outputUsdPerMtok;
  const cwr = long?.cacheWriteUsdPerMtok ?? price.cacheWriteUsdPerMtok ?? ir * 1.25;
  const crr = long?.cacheReadUsdPerMtok ?? price.cacheReadUsdPerMtok ?? ir * 0.1;

  let usd = 0;
  usd += (inputTok / 1_000_000) * ir;
  usd += (outputTok / 1_000_000) * or;
  usd += (cwTok / 1_000_000) * cwr;
  usd += (crTok / 1_000_000) * crr;
  return usd;
}

/** Sum cost across many turns. Each turn carries its own model id so
 *  mixed-provider conversations price each turn correctly. Rounded
 *  to 1/100 of a cent — anything finer is noise. */
export function costForTurns(
  turns: Array<{ modelId: string; usage?: TokenUsage }>,
): number {
  let total = 0;
  for (const t of turns) total += costForTurn(t.modelId, t.usage);
  return Math.round(total * 10000) / 10000;
}
