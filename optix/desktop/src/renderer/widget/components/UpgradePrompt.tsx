// Inline error surface for Optix Cloud billing failures.
//
// When the relay returns 402 (subscription_inactive) or 429 (allowance
// exceeded) mid-prompt, the response area normally shows a plain red
// error toast. But these failures are recoverable with one click, so
// instead of a generic toast we render a structured card with copy
// tailored to the failure code and an action button that fixes it
// directly:
//
//   monthly_allowance_exceeded + tier=starter → "Upgrade to Pro"
//   monthly_allowance_exceeded + tier=pro     → "Wait until <date>"  (info only)
//   subscription_inactive                     → "Open Settings" (sub flow lives there)
//   subscription_incomplete                   → "Try again" (transient webhook race)
//   no_user_record                            → "Try again" (account-create race)
//
// The component decodes the error using the shared codec
// `decodeOptixCloudBillingError`. Plain-string errors fall through to
// the existing `widget__error` div.

import { useState } from 'react';
import { decodeOptixCloudBillingError } from '../../../shared/optix-cloud-errors';
import type { UserProfile } from '../firebase';
import { getFreshIdToken } from '../firebase';

type UpgradePromptProps = {
  /** The error.message thrown by the optix-cloud provider/agent. May
   *  or may not contain a billing-prefix payload — `null` here means
   *  the caller should fall back to plain-error rendering. */
  errorMessage: string;
  /** Live user profile from the Firestore listener. Used to:
   *  - know the current tier so we can show "Upgrade to Pro" or not
   *  - know `currentPeriodEnd` so we can show when allowance resets */
  userProfile: UserProfile | null;
  /** Open the Settings panel (e.g. for subscription_inactive — there's
   *  no in-place subscribe flow; the pricing cards live in Settings). */
  onOpenSettings: () => void;
};

/** Returns null when the error isn't a known billing failure — the
 *  caller falls back to its plain-error rendering. */
export function UpgradePrompt({
  errorMessage,
  userProfile,
  onOpenSettings,
}: UpgradePromptProps): JSX.Element | null {
  const billing = decodeOptixCloudBillingError(errorMessage);
  if (!billing) return null;

  // Local state for the in-place "Upgrade" action button. Same pattern
  // the Settings panel uses, just narrowed to the single switchPlan
  // case we need here.
  type ActionState =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'error'; message: string };
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' });

  async function upgradeToPro() {
    setActionState({ kind: 'busy' });
    try {
      const token = await getFreshIdToken();
      if (!token) {
        setActionState({
          kind: 'error',
          message: 'Sign-in expired. Open Settings to sign in again.',
        });
        return;
      }
      await window.optix.stripe.updateSubscription({
        action: 'switchPlan',
        tier: 'pro',
        authToken: token,
      });
      // Stripe's webhook will update Firestore in ~1s; the Settings
      // panel's onSnapshot listener will reflect it. Resubmit-the-prompt
      // is up to the user — we don't auto-retry because their original
      // prompt may have been long since dismissed.
      setActionState({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionState({ kind: 'error', message });
    }
  }

  // Branch on the structured code, NOT the human-readable message —
  // copy is owned here so it can change without re-deploying the
  // Cloud Functions, and the actions are tied to the code semantics.
  return (
    <div className="upgrade-prompt">
      <div className="upgrade-prompt__title">{titleFor(billing.code)}</div>
      <div className="upgrade-prompt__body">
        {bodyFor(billing, userProfile)}
      </div>
      <div className="upgrade-prompt__actions">
        {renderAction(billing, userProfile, {
          actionState,
          upgradeToPro,
          onOpenSettings,
        })}
      </div>
      {actionState.kind === 'error' && (
        <div className="upgrade-prompt__error">✗ {actionState.message}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function titleFor(code: ReturnType<typeof decodeOptixCloudBillingError> extends infer T
  ? T extends { code: infer C }
    ? C
    : never
  : never): string {
  switch (code) {
    case 'monthly_allowance_exceeded':
      return 'Monthly token allowance exhausted';
    case 'subscription_inactive':
      return 'Optix Cloud subscription inactive';
    case 'subscription_incomplete':
      return 'Subscription not fully ready';
    case 'no_user_record':
      return 'Account still being set up';
    default:
      return 'Optix Cloud is unavailable';
  }
}

function bodyFor(
  billing: NonNullable<ReturnType<typeof decodeOptixCloudBillingError>>,
  profile: UserProfile | null,
): string {
  switch (billing.code) {
    case 'monthly_allowance_exceeded': {
      const cap = billing.cap ?? profile?.tokenAllowanceMonthly;
      const renewsOn = profile?.currentPeriodEnd
        ? new Date(profile.currentPeriodEnd).toLocaleDateString()
        : null;
      const onPro = profile?.tier === 'pro';
      const usage = cap ? `${formatMillions(cap)} / month` : 'this month';
      if (onPro) {
        return renewsOn
          ? `You've used your full ${usage} on the Pro plan. Allowance resets on ${renewsOn}.`
          : `You've used your full ${usage} on the Pro plan. Allowance resets at the start of next month.`;
      }
      return renewsOn
        ? `You've used your full ${usage} on the Starter plan. Upgrade to Pro for 15M tokens, or wait until ${renewsOn}.`
        : `You've used your full ${usage} on the Starter plan. Upgrade to Pro for 15M tokens, or wait until next month.`;
    }
    case 'subscription_inactive':
      return 'Your subscription is paused or never activated. Open Settings to subscribe — pick Starter or Pro and you can keep going.';
    case 'subscription_incomplete':
      return 'Your subscription is active but missing its token allowance — usually a brief webhook delay. Try the prompt again in a few seconds.';
    case 'no_user_record':
      return "We're still finishing your account setup. Try the prompt again in a few seconds — this should clear on its own.";
    default:
      return 'Optix Cloud returned an unexpected error.';
  }
}

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

function renderAction(
  billing: NonNullable<ReturnType<typeof decodeOptixCloudBillingError>>,
  profile: UserProfile | null,
  ctx: {
    actionState: { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string };
    upgradeToPro: () => void;
    onOpenSettings: () => void;
  },
): JSX.Element {
  const busy = ctx.actionState.kind === 'busy';

  // Starter user hit the cap → show the upgrade button inline. Pro
  // users can't upgrade further; just show "Open Settings" so they can
  // see the renewal date / cancel / etc. without leaving the surface.
  if (billing.code === 'monthly_allowance_exceeded') {
    if (profile?.tier === 'starter') {
      return (
        <button
          type="button"
          className="btn upgrade-prompt__cta"
          onClick={ctx.upgradeToPro}
          disabled={busy}
        >
          {busy ? 'Upgrading Plan…' : 'Upgrade to Pro'}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="btn"
        onClick={ctx.onOpenSettings}
        disabled={busy}
      >
        Open Settings
      </button>
    );
  }

  // Subscription not active or incomplete → only place to fix is
  // Settings (sign-in form, pricing cards, payment-method portal).
  return (
    <button
      type="button"
      className="btn upgrade-prompt__cta"
      onClick={ctx.onOpenSettings}
      disabled={busy}
    >
      Open Settings
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMillions(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M tokens`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k tokens`;
  }
  return `${n} tokens`;
}
