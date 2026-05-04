// Shared encoding for Optix Cloud billing errors.
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

/** Distinct billing-related failure modes the relay can return. */
export type OptixCloudBillingCode =
  | 'subscription_inactive' // 402 — never subscribed, canceled, or past_due past grace
  | 'subscription_incomplete' // 402 — active but missing tokenAllowance (rare)
  | 'monthly_allowance_exceeded' // 429 — burned through monthly cap
  | 'no_user_record'; // 403 — Firestore profile missing (webhook delay)

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
 *  for non-billing errors so callers can fall back to plain rendering. */
export function decodeOptixCloudBillingError(
  message: string,
): OptixCloudBillingError | null {
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

function isKnownCode(code: string): code is OptixCloudBillingCode {
  return (
    code === 'subscription_inactive' ||
    code === 'subscription_incomplete' ||
    code === 'monthly_allowance_exceeded' ||
    code === 'no_user_record'
  );
}
