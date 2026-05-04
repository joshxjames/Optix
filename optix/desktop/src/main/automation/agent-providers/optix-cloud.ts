// Optix Cloud Computer-Use adapter.
//
// Functionally identical to the Anthropic agent adapter — same Claude
// system prompt, same tool definitions, same parsing, same usage
// reporting — except every API call is routed through our Firebase
// relay with a Bearer token instead of `api.anthropic.com` with an
// `x-api-key`.
//
// We achieve this with a tiny wrapper: take the existing adapter,
// replace its `init` so the Anthropic SDK client gets `baseURL` +
// `authToken` instead of `apiKey`. Everything else (`step`,
// `appendResults`, `appendUserTurn`) re-uses the same logic untouched.
// One source of truth, no drift.

import Anthropic from '@anthropic-ai/sdk';
import { remapToBillingErrorIfPossible } from '@main/providers/optix-cloud';
import { anthropicAgentAdapter, type AnthropicState } from './anthropic';
import type {
  AgentInitOpts,
  AgentProviderAdapter,
  AgentTurnResult,
} from './types';

// Same relay endpoint the Ask-mode provider uses. Anthropic SDK appends
// `/v1/messages` itself, so we configure one segment short.
const RELAY_BASE_URL = 'https://us-central1-optix-22473.cloudfunctions.net/relay';

function makeRelayClient(authToken: string): Anthropic {
  // Explicit `apiKey: null` defeats the SDK's `ANTHROPIC_API_KEY` env-var
  // default — without it, any apiKey env value (even empty string) wins
  // over `authToken` and the request fails auth resolution.
  return new Anthropic({ apiKey: null, authToken, baseURL: RELAY_BASE_URL });
}

export const optixCloudAgentAdapter: AgentProviderAdapter<AnthropicState> = {
  ...anthropicAgentAdapter,
  id: 'optixCloud',

  init(opts: AgentInitOpts): AnthropicState {
    // Run the base adapter's init so the message history, pending-action
    // maps, and image blocks are constructed exactly the same way.
    const state = anthropicAgentAdapter.init(opts);
    // Then swap the SDK client for one pointed at our relay. `opts.apiKey`
    // is, in this provider's contract, the user's Firebase ID token —
    // the renderer fetches a fresh one before every loop step. The relay
    // verifies it server-side and rejects with 401 if expired or invalid.
    state.client = makeRelayClient(opts.apiKey);
    return state;
  },

  // Conversation-mode loops can sit paused for hours between user
  // submits. Firebase tokens expire after ~1 hour, so before each
  // continue / appendUserTurn the loop driver hands us a fresh one and
  // we rebuild the SDK client around it. Without this the next API
  // call would fail with 401 and the user would have to start over.
  refreshCredential(state: AnthropicState, credential: string): void {
    state.client = makeRelayClient(credential);
  },

  // Wrap step() so Anthropic SDK errors that originate from a billing
  // response (402 / 429) get re-thrown as structured Optix Cloud
  // billing errors. Without this wrap, the Access loop surfaces a raw
  // "402 Payment Required" toast in the response area instead of the
  // upgrade prompt the user can act on.
  async step(
    state: AnthropicState,
    abortSignal: AbortSignal,
  ): Promise<AgentTurnResult> {
    try {
      return await anthropicAgentAdapter.step(state, abortSignal);
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw remapToBillingErrorIfPossible(err);
      }
      throw err;
    }
  },
};
