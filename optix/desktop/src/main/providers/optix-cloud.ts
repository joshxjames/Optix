// Optix Cloud Ask-mode adapter.
//
// Speaks the exact same Anthropic wire protocol as the direct Anthropic
// adapter — same models, same system prompts, same streaming format,
// same web-search fallback (native web_search_20250305 first, DDG
// second). The only difference is the SDK client: instead of pointing
// at `api.anthropic.com` with an `x-api-key`, it points at our Firebase
// relay with a Bearer token (the user's Firebase ID token). The relay
// attaches the admin Anthropic key and meters usage for billing.
//
// All the message-building, tool loops, and response parsing live in
// `runAnthropicPrompt` over in `anthropic.ts` — we just inject our
// relay-bound client and reuse the entire pipeline. One source of
// truth keeps the two adapters from drifting.

import Anthropic from '@anthropic-ai/sdk';
import type { ModelResponse } from '@shared/schemas';
import {
  encodeOptixCloudBillingError,
  type OptixCloudBillingCode,
} from '@shared/optix-cloud-errors';
import { runAnthropicPrompt } from './anthropic';
import type { Provider, PromptInput } from './base';

// Cloud Functions Gen 2 / Cloud Run endpoint exposed by `optix-cloud`.
// The relay handles `/v1/messages`; the SDK appends that path itself,
// so we configure the base URL one segment short.
const RELAY_BASE_URL = 'https://us-central1-optix-22473.cloudfunctions.net/relay';

// We re-instantiate the Anthropic client per ID token because tokens
// rotate every hour and the SDK bakes the auth header in at construction
// time. The map keys by token so a token in flight reuses the same
// client; new tokens drop their old entries on next access.
const clientCache = new Map<string, Anthropic>();

function getOptixCloudClient(idToken: string): Anthropic {
  let client = clientCache.get(idToken);
  if (!client) {
    client = new Anthropic({
      // Explicitly null out apiKey so the SDK's auth resolver picks the
      // bearer path. Without this, an `ANTHROPIC_API_KEY` env var set
      // anywhere on the host (even to "") wins over `authToken` and the
      // request goes out with an empty `X-Api-Key` and no Authorization
      // — surfaces as "Could not resolve authentication method".
      apiKey: null,
      // Sends `Authorization: Bearer <token>` — what the relay's
      // middleware checks for.
      authToken: idToken,
      baseURL: RELAY_BASE_URL,
      defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'false' },
    });
    clientCache.set(idToken, client);
  }
  return client;
}

export const optixCloudProvider: Provider = {
  id: 'optixCloud',

  async prompt(input: PromptInput, idToken: string): Promise<ModelResponse> {
    try {
      return await runAnthropicPrompt(getOptixCloudClient(idToken), input);
    } catch (err) {
      // The SDK turns 401/402/429 from the relay into typed errors —
      // re-prefix so the renderer's error toast tells the user where
      // the failure came from (subscription / sign-in vs the model).
      if (err instanceof Anthropic.APIError) {
        throw remapToBillingErrorIfPossible(err);
      }
      throw err;
    }
  },

  async testKey(idToken: string): Promise<void> {
    // Smallest possible call to verify auth + subscription state. The
    // relay returns a JSON error body if the token is invalid or the
    // subscription is inactive; the SDK surfaces those as APIError.
    const client = getOptixCloudClient(idToken);
    try {
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw remapToBillingErrorIfPossible(err);
      }
      throw err;
    }
  },
};

/** When an SDK error wraps a known billing-failure response from the
 *  relay, re-throw it through the structured-error encoder so the
 *  renderer can render an upgrade-prompt instead of a plain toast.
 *  Anything else (auth, network, model) falls through to a plain
 *  message — those don't have a recoverable in-widget UX path. */
export function remapToBillingErrorIfPossible(
  err: InstanceType<typeof Anthropic.APIError>,
): Error {
  // The Anthropic SDK exposes the parsed body on `err.error`. The
  // relay's contract puts the structured code at `body.error` (string
  // like 'subscription_inactive') with optional `used` / `cap` for 429.
  const body = (err as unknown as { error?: { error?: string; used?: number; cap?: number } }).error;
  const code = body?.error;
  if (typeof code === 'string' && isBillingCode(code)) {
    return new Error(
      encodeOptixCloudBillingError(
        {
          status: err.status ?? 0,
          code,
          used: body?.used,
          cap: body?.cap,
        },
        humanReadableForCode(code, err.status ?? 0),
      ),
    );
  }
  // Auth failures, model errors, anything else — pass through with the
  // same prefix the prior code used so existing error-toast handling
  // still recognises Optix Cloud as the source.
  return new Error(`Optix Cloud: ${err.status} ${err.message}`);
}

function isBillingCode(code: string): code is OptixCloudBillingCode {
  return (
    code === 'subscription_inactive' ||
    code === 'subscription_incomplete' ||
    code === 'monthly_allowance_exceeded' ||
    code === 'no_user_record'
  );
}

function humanReadableForCode(
  code: OptixCloudBillingCode,
  status: number,
): string {
  switch (code) {
    case 'subscription_inactive':
      return 'Optix Cloud subscription is not active. Open Settings to subscribe or update your plan.';
    case 'subscription_incomplete':
      return 'Optix Cloud subscription is missing a token allowance. Try again in a moment, or contact support if the issue persists.';
    case 'monthly_allowance_exceeded':
      return 'Optix Cloud monthly token allowance is exhausted. Upgrade to Pro or wait until your next renewal.';
    case 'no_user_record':
      return 'Optix Cloud profile not found yet. Try again in a few seconds — the account is being set up.';
    default:
      return `Optix Cloud: ${status} ${code}`;
  }
}
