// Curated list of vision-capable models per provider. Users can paste
// a custom model ID in settings if they want one not listed.
//
// ID-convention policy: model IDs SHOULD be pinned dated snapshots
// (e.g. `claude-haiku-4-5-20251001`, `gpt-4o-2024-11-20`) rather than
// rolling base aliases. Snapshots make billing/cost reporting
// deterministic and stop a silent quality regression when a provider
// re-points the alias. Where a snapshot ID isn't yet known we leave a
// TODO and ship the base ID — pricing.ts longest-prefix-matches both
// shapes so this is safe in the interim.
//
// Every ID here MUST have a matching entry in `pricing.ts` (or be
// covered by its base-name fallback). pricing.ts logs a console.warn
// at module init if anything is missing.

import type { ProviderId } from './schemas';

export type ModelEntry = {
  id: string;
  label: string;
  note?: string;
};

export const MODELS_BY_PROVIDER: Record<ProviderId, ModelEntry[]> = {
  anthropic: [
    // TODO(snapshot): pin `claude-opus-4-7-YYYYMMDD` once Anthropic
    // publishes a dated release ID we want to lock to.
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', note: 'Recommended — best GUI grounding.' },
    // TODO(snapshot): pin `claude-sonnet-4-6-YYYYMMDD`.
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'Fastest / cheapest.' },
  ],
  openai: [
    { id: 'gpt-4o-2024-11-20', label: 'GPT-4o', note: 'Recommended.' },
    { id: 'gpt-4o-mini-2024-07-18', label: 'GPT-4o mini', note: 'Cheaper.' },
  ],
  kimi: [
    { id: 'kimi-k2.5', label: 'Kimi K2.5', note: 'Recommended — native multimodal.' },
    { id: 'kimi-latest', label: 'Kimi (latest vision alias)' },
    { id: 'moonshot-v1-8k-vision-preview', label: 'Moonshot v1 8k vision', note: 'Stable fallback.' },
  ],
  google: [
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', note: 'Recommended.' },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', note: 'Cheaper / faster.' },
    { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (experimental)' },
  ],
  // Optix Cloud forwards to Anthropic via the relay, so the same Claude
  // model menu applies. Cost shows up on the user's subscription bill,
  // not directly per-token.
  optixCloud: [
    // TODO(snapshot): match the Anthropic entries above once snapshots
    // are pinned — relay accepts the same model IDs.
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', note: 'Recommended — best GUI grounding.' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'Fastest / cheapest.' },
  ],
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  kimi: 'Moonshot (Kimi)',
  google: 'Google Gemini',
  optixCloud: 'Optix Cloud',
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  // TODO(snapshot): switch to dated snapshots once pinned upstream.
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o-2024-11-20',
  kimi: 'kimi-k2.5',
  google: 'gemini-1.5-pro',
  optixCloud: 'claude-opus-4-7',
};
