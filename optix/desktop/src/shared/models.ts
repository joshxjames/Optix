import type { ProviderId } from './schemas';

// Curated list of vision-capable models per provider.
// Users can paste a custom model ID in settings if they want to use one not listed.

export type ModelEntry = {
  id: string;
  label: string;
  note?: string;
};

export const MODELS_BY_PROVIDER: Record<ProviderId, ModelEntry[]> = {
  anthropic: [
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', note: 'Recommended — best GUI grounding.' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'Fastest / cheapest.' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o', note: 'Recommended.' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', note: 'Cheaper.' },
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
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  kimi: 'Moonshot (Kimi)',
  google: 'Google Gemini',
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  kimi: 'kimi-k2.5',
  google: 'gemini-1.5-pro',
};
