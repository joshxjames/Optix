// Per-model pricing + cost estimation, used to track Optix Cloud
// spend on the user's behalf and to surface per-turn costs in the UI.
//
// SCOPE: only Anthropic models (and the Optix-Cloud-relayed variants
// of those same models) are priced here. Other providers — OpenAI,
// Kimi, Google Gemini — are self-funded by users with their own API
// keys; we don't intermediate billing for them, so tracking their
// per-token rates would be a maintenance burden with no business
// benefit. `costForTurn()` returns 0 for those providers, and the UI
// is expected to suppress the cost label rather than show "$0.00".
//
// All rates are USD per million tokens. Cache rates are declared
// explicitly on every entry — no implicit input-multiplier fallback,
// because silent zero-cost surprises are worse than a typecheck error
// when a new model is added.
//
// Convention: every Anthropic model ID listed in `shared/models.ts`
// MUST have a matching entry here, and dated snapshots
// (e.g. `claude-haiku-4-5-20251001`) get their own entry alongside the
// base name (`claude-haiku-4-5`). The base entry stays around as a
// longest-prefix fallback for older stored model IDs after a snapshot
// is deprecated. Module init logs a console warning if an Anthropic /
// Optix-Cloud entry is missing pricing.

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

const PRICING: Record<string, ModelPricing> = {
  // --- Anthropic: base names (longest-prefix fallback) ---
  'claude-opus-4-7': OPUS_4_7,
  'claude-sonnet-4-6': SONNET_4_6,
  'claude-haiku-4-5': HAIKU_4_5,

  // --- Anthropic: dated snapshots used in models.ts ---
  // TODO(snapshot): pin opus/sonnet snapshot IDs once we adopt dated
  // versions; currently models.ts ships these as base IDs.
  'claude-haiku-4-5-20251001': HAIKU_4_5,
};

// Loud-during-dev sanity check: every Anthropic / Optix-Cloud model in
// the picker must have a pricing entry, since those are the rates we
// bill the user for. Other providers (OpenAI, Kimi, Google) are
// user-funded via their own API keys — they're intentionally absent
// from the warning list.
(function warnOnMissingPricing() {
  const priced: Array<[string, string]> = [];
  for (const [provider, entries] of Object.entries(MODELS_BY_PROVIDER)) {
    if (provider !== 'anthropic' && provider !== 'optixCloud') continue;
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

/** Cost of one turn in USD. Returns 0 for non-Anthropic/Optix-Cloud
 *  models (BYO-key providers — see file header) so the UI suppresses
 *  the cost label rather than misrepresenting "$0.00" as "free".
 *  Callers that need to distinguish "no pricing data" from "genuinely
 *  $0" can call `resolvePricing` first. */
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
