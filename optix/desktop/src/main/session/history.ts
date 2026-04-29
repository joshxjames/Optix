import { randomUUID } from 'node:crypto';
import type { HistoryEntry, ModelResponse, PromptRequest, ProviderId } from '@shared/schemas';

// Phase 1: in-memory ring buffer. Phase 2+ will persist to disk under a
// privacy-controlled retention policy.
const MAX_ENTRIES = 50;
const entries: HistoryEntry[] = [];

export function record(
  req: PromptRequest,
  providerId: ProviderId,
  modelId: string,
  result: { response?: ModelResponse; error?: string },
): HistoryEntry {
  const entry: HistoryEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: req.mode,
    prompt: req.prompt,
    providerId,
    modelId,
    response: result.response,
    error: result.error,
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}

export function list(): HistoryEntry[] {
  return [...entries];
}

export function clear(): void {
  entries.length = 0;
}
