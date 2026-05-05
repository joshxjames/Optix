// Shared encoding for Optix Cloud billing/relay errors.
//
// Contract — read before changing:
//   - Adding a new code is SAFE. Consumers (provider, IPC handler,
//     renderer) gracefully fall back to a generic message when they
//     don't recognise a code.
//   - Renaming or REMOVING a code is BREAKING — old encoded errors
//     persist in chat history / pending IPC frames, so removed codes
//     re-appear at runtime. Treat the enum as append-only.
//   - `decodeOptixCloudBillingError` must NEVER throw on malformed
//     input — it returns null and lets callers fall back to plain
//     error rendering.
//
// When the relay returns 402 (subscription_inactive / subscription_incomplete)
// or 429 (monthly_allowance_exceeded), the desktop client wants to render a
// dedicated "upgrade / fix-billing" UI instead of a plain error toast — the
// failure mode is recoverable with a click, not a retry. To do that the
// renderer needs the structured `code` (and ideally the HTTP status), but
// IPC serialises thrown `Error`s as `{ message, name, stack }` only —
// custom properties don't survive.
//
// Solution: pack the structured info into the `Error.message` itself with a
// stable prefix (`OPTIX_BILLING:<json>:`) that the renderer detects and
// strips. Any code in the chain (provider → IPC handler → renderer) sees
// a normal Error with a sensible message; only the renderer's billing-aware
// surface uses the prefix to swap in the upgrade prompt.

import type { Tier } from './schemas';

/** Distinct billing/relay failure modes the relay can return. Append-only.
 *  - subscription_inactive: 402 — never subscribed, canceled, or past_due past grace
 *  - subscription_incomplete: 402 — active but missing tokenAllowance (rare)
 *  - monthly_allowance_exceeded: 429 — burned through monthly cap
 *  - no_user_record: 403 — Firestore profile missing (webhook delay)
 *  - invalid_auth: 401 — Firebase ID token invalid/expired
 *  - rate_limited: 429 (non-billing) — relay-level throttle
 *  - model_not_available: 404/400 — selected model rejected upstream
 *  - invalid_request: 400 — payload rejected (e.g. context too large)
 *  - relay_unavailable: 502/503/504 — relay or upstream down */
export type OptixCloudBillingCode =
  | 'subscription_inactive'
  | 'subscription_incomplete'
  | 'monthly_allowance_exceeded'
  | 'no_user_record'
  | 'invalid_auth'
  | 'rate_limited'
  | 'model_not_available'
  | 'invalid_request'
  | 'relay_unavailable';

export type OptixCloudBillingError = {
  /** HTTP status from the relay. */
  status: number;
  /** Structured code. Renderer maps this to copy + action buttons. */
  code: OptixCloudBillingCode;
  /** Token usage at the time of the failure, when 429. Mainly for the
   *  "X / Y tokens used" line in the upgrade card. */
  used?: number;
  cap?: number;
  /** The user's current tier (if any) — used by the renderer to decide
   *  whether to render an "Upgrade to Pro" CTA (Starter users) or a
   *  "Wait until renewal" message (Pro users already at the top tier). */
  tier?: Tier;
};

const PREFIX = 'OPTIX_BILLING:';

/** Pack a billing error into a string suitable for `new Error(...)`. */
export function encodeOptixCloudBillingError(
  err: OptixCloudBillingError,
  humanReadable: string,
): string {
  // JSON.stringify is safe — none of the fields can contain a colon
  // unescaped that would break our regex. The trailing `:` separates
  // the JSON from the human-readable message so the prefix is greedy
  // up to that boundary.
  return `${PREFIX}${JSON.stringify(err)}:${humanReadable}`;
}

/** Try to pull a billing error out of an Error.message. Returns null
 *  for non-billing errors so callers can fall back to plain rendering.
 *  Never throws — malformed input yields null. */
export function decodeOptixCloudBillingError(
  message: string,
): OptixCloudBillingError | null {
  if (typeof message !== 'string') return null;
  if (!message.startsWith(PREFIX)) return null;
  // Find the closing brace + colon that terminates the JSON segment.
  // Pull the JSON slice and parse it. If anything's malformed treat
  // the whole error as plain — the prefix-only message will surface
  // as-is and the worst case is a slightly uglier toast.
  const jsonEnd = message.indexOf('}:', PREFIX.length);
  if (jsonEnd === -1) return null;
  const jsonSlice = message.slice(PREFIX.length, jsonEnd + 1);
  try {
    const parsed = JSON.parse(jsonSlice) as Partial<OptixCloudBillingError>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.status === 'number' &&
      typeof parsed.code === 'string' &&
      isKnownCode(parsed.code)
    ) {
      return {
        status: parsed.status,
        code: parsed.code,
        used: typeof parsed.used === 'number' ? parsed.used : undefined,
        cap: typeof parsed.cap === 'number' ? parsed.cap : undefined,
        tier:
          parsed.tier === 'starter' || parsed.tier === 'pro'
            ? parsed.tier
            : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip the billing-prefix off an error message, returning just the
 *  human-readable tail. Useful when something needs to surface the
 *  message in a plain context (logs, fallback toast). */
export function stripBillingPrefix(message: string): string {
  if (!message.startsWith(PREFIX)) return message;
  const jsonEnd = message.indexOf('}:', PREFIX.length);
  if (jsonEnd === -1) return message;
  return message.slice(jsonEnd + 2);
}

/** Map a structured code to user-facing copy. Consumers can wrap or
 *  override per-surface, but having a shared default keeps toast
 *  language consistent across renderer + main. */
export function humanReadableForCode(code: OptixCloudBillingCode): string {
  switch (code) {
    case 'subscription_inactive':
      return 'Optix Cloud subscription is not active. Open Settings to subscribe or update your plan.';
    case 'subscription_incomplete':
      return 'Optix Cloud subscription is missing a token allowance. Try again in a moment, or contact support if the issue persists.';
    case 'monthly_allowance_exceeded':
      return 'Optix Cloud monthly token allowance is exhausted. Upgrade to Pro or wait until your next renewal.';
    case 'no_user_record':
      return 'Optix Cloud profile not found yet. Try again in a few seconds — the account is being set up.';
    case 'invalid_auth':
      return 'Your sign-in session expired. Please sign in again.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'model_not_available':
      return "The selected model isn't available right now. Try a different model.";
    case 'invalid_request':
      return 'The request was rejected by the relay. Try a shorter prompt.';
    case 'relay_unavailable':
      return 'Optix Cloud is temporarily unavailable. Please try again shortly.';
  }
}

function isKnownCode(code: string): code is OptixCloudBillingCode {
  return (
    code === 'subscription_inactive' ||
    code === 'subscription_incomplete' ||
    code === 'monthly_allowance_exceeded' ||
    code === 'no_user_record' ||
    code === 'invalid_auth' ||
    code === 'rate_limited' ||
    code === 'model_not_available' ||
    code === 'invalid_request' ||
    code === 'relay_unavailable'
  );
}
