// Per-model pricing + cost estimation. Lifted out of audit.ts so the
// chat-history module can compute Ask-mode costs from the same source
// of truth — keeping the rate table in one place avoids drift when
// providers change their prices.
//
// All rates are USD per million tokens. Cache rates are declared
// explicitly on every entry — no implicit input-multiplier fallback,
// because silent zero-cost surprises are worse than a typecheck error
// when a new model is added.
//
// Convention: every model ID listed in `shared/models.ts` MUST have a
// matching entry here, and dated snapshots (e.g. `claude-haiku-4-5-20251001`)
// get their own entry alongside the base name (`claude-haiku-4-5`). The
// base entry stays around as a longest-prefix fallback for older stored
// model IDs after a snapshot is deprecated. Module init logs a console
// warning if a `MODELS_BY_PROVIDER` entry is missing pricing.

import { MODELS_BY_PROVIDER } from './models';
import type { TokenUsage } from './schemas';

type ModelPricing = {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWriteUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
  /** Anthropic 1M-context tier: when a turn's input + cache tokens
   *  exceed `thresholdTokens`, that turn is billed at the long-context
   *  rates. Per-turn check, not aggregate. */
  longContext?: {
    thresholdTokens: number;
    inputUsdPerMtok: number;
    outputUsdPerMtok: number;
    cacheWriteUsdPerMtok: number;
    cacheReadUsdPerMtok: number;
  };
};

// Anthropic published rates (USD/Mtok). Cache-write = input × 1.25,
// cache-read = input × 0.10 — declared explicitly so future rate
// shifts don't silently round to zero.
const OPUS_4_7: ModelPricing = {
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
};

const SONNET_4_6: ModelPricing = {
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
};

const HAIKU_4_5: ModelPricing = {
  inputUsdPerMtok: 1,
  outputUsdPerMtok: 5,
  cacheWriteUsdPerMtok: 1.25,
  cacheReadUsdPerMtok: 0.1,
};

// OpenAI published rates. No prompt-caching pricing distinct from
// input on these models — we set cacheRead = input × 0.5 (OpenAI's
// cached-input discount) and cacheWrite = input (no surcharge).
const GPT_4O: ModelPricing = {
  inputUsdPerMtok: 2.5,
  outputUsdPerMtok: 10,
  cacheWriteUsdPerMtok: 2.5,
  cacheReadUsdPerMtok: 1.25,
};

const GPT_4O_MINI: ModelPricing = {
  inputUsdPerMtok: 0.15,
  outputUsdPerMtok: 0.6,
  cacheWriteUsdPerMtok: 0.15,
  cacheReadUsdPerMtok: 0.075,
};

const PRICING: Record<string, ModelPricing> = {
  // --- Anthropic: base names (longest-prefix fallback) ---
  'claude-opus-4-7': OPUS_4_7,
  'claude-sonnet-4-6': SONNET_4_6,
  'claude-haiku-4-5': HAIKU_4_5,

  // --- Anthropic: dated snapshots used in models.ts ---
  // TODO(snapshot): pin opus/sonnet snapshot IDs once Agent picks dated
  // versions; currently models.ts ships these as base IDs.
  'claude-haiku-4-5-20251001': HAIKU_4_5,

  // --- OpenAI: base names (longest-prefix fallback) ---
  'gpt-4o': GPT_4O,
  'gpt-4o-mini': GPT_4O_MINI,

  // --- OpenAI: dated snapshots ---
  'gpt-4o-2024-11-20': GPT_4O,
  'gpt-4o-2024-08-06': GPT_4O,
  'gpt-4o-mini-2024-07-18': GPT_4O_MINI,
};

// Loud-during-dev sanity check: every model in the picker should price.
// We only warn on Anthropic + OpenAI; Kimi and Google are priced
// elsewhere (or not at all) and are out of scope here.
(function warnOnMissingPricing() {
  const priced: Array<[string, string]> = [];
  for (const [provider, entries] of Object.entries(MODELS_BY_PROVIDER)) {
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'optixCloud') continue;
    for (const m of entries) {
      if (!resolvePricing(m.id)) priced.push([provider, m.id]);
    }
  }
  if (priced.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[pricing] Missing pricing entries for models:',
      priced.map(([p, id]) => `${p}:${id}`).join(', '),
    );
  }
})();

/** Resolve a (possibly dated/snapshot) model ID via longest-prefix
 *  match — e.g. `claude-opus-4-7-20250115` → `claude-opus-4-7`.
 *  Exact matches always win over prefix matches. */
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
  const cwr = long?.cacheWriteUsdPerMtok ?? price.cacheWriteUsdPerMtok;
  const crr = long?.cacheReadUsdPerMtok ?? price.cacheReadUsdPerMtok;

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
