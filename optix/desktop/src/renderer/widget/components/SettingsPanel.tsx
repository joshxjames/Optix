import { useEffect, useMemo, useState } from 'react';
import type { ProviderId, Settings } from '../../../shared/schemas';
import { MODELS_BY_PROVIDER, PROVIDER_LABELS } from '../../../shared/models';
import { AuditLogViewer } from './AuditLogViewer';
import { ChatHistoryViewer } from './ChatHistoryViewer';
import { RoutinesViewer } from './RoutinesViewer';
import {
  cancelSignIn,
  getFreshIdToken,
  onAuthChanged,
  onUsageThisMonthChanged,
  onUserProfileChanged,
  sendSignInLink,
  signOut as signOutOptixCloud,
  type UsageThisMonth,
  type UserProfile,
} from '../firebase';

const PROVIDER_IDS: ProviderId[] = [
  'anthropic',
  'openai',
  'kimi',
  'google',
  'optixCloud',
];

type SignInStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string };

type SubscribeStatus =
  | { kind: 'idle' }
  | { kind: 'opening'; tier: 'starter' | 'pro' }
  | { kind: 'awaiting'; tier: 'starter' | 'pro' }
  | { kind: 'error'; message: string };

type Plan = {
  tier: 'starter' | 'pro';
  label: string;
  price: string;
  blurb: string;
  features: string[];
};

const PLANS: Plan[] = [
  {
    tier: 'starter',
    label: 'Starter',
    price: '$49 / month',
    blurb: 'For light to moderate users.',
    features: [
      '5M tokens / month',
      'Claude Opus 4.7 included',
      'Ask + Access + Automate',
      'Web search included',
    ],
  },
  {
    tier: 'pro',
    label: 'Pro',
    price: '$99 / month',
    blurb: 'For heavy daily use.',
    features: [
      '15M tokens / month',
      'Claude Opus 4.7 included',
      'Ask + Access + Automate',
      'Web search included',
      'Priority support',
    ],
  },
];

type Props = {
  settings: Settings;
  onClose: () => void;
};

type KeyStatus =
  | { kind: 'unknown' }
  | { kind: 'stored' }
  | { kind: 'missing' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

export function SettingsPanel({ settings, onClose }: Props) {
  const activeId = settings.activeProviderId;
  const models = MODELS_BY_PROVIDER[activeId];
  const currentModelId = settings.modelByProvider[activeId] ?? '';
  const isCustomModel = useMemo(
    () => !models.some((m) => m.id === currentModelId),
    [models, currentModelId],
  );

  const [keyInput, setKeyInput] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [status, setStatus] = useState<KeyStatus>({ kind: 'unknown' });
  const [view, setView] = useState<'settings' | 'audit' | 'chat' | 'routines'>('settings');

  // Optix Cloud sign-in state. `signedInUser` reflects Firebase auth
  // state directly — null when signed out, populated when signed in.
  // `signInStatus` drives the in-flight UI for the magic-link flow.
  const [signedInUser, setSignedInUser] = useState<{ email: string } | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [signInStatus, setSignInStatus] = useState<SignInStatus>({ kind: 'idle' });
  // Live mirror of the user's Firestore profile doc — drives the
  // subscription UI. Updates the moment the Stripe webhook flips
  // `subscriptionStatus` to 'active', so the pricing cards swap to
  // "you're subscribed" without polling.
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // Live mirror of `users/{uid}/usage/{yyyymm}` — used to render the
  // "X / Y tokens" label in the active-plan view. Updates every time
  // the relay writes a new request's counter.
  const [usage, setUsage] = useState<UsageThisMonth | null>(null);
  const [subscribeStatus, setSubscribeStatus] = useState<SubscribeStatus>({
    kind: 'idle',
  });

  // Subscribe to Firebase auth state once. The SDK rehydrates from
  // IndexedDB on mount, so this fires immediately with the persisted
  // user if any — no need for a separate "check on load" step.
  useEffect(() => {
    return onAuthChanged((user) => {
      setSignedInUser(user ? { email: user.email } : null);
      // The user just completed sign-in via the email link callback —
      // clear the in-flight UI and let the "Signed in as ..." panel
      // take over.
      if (user) setSignInStatus({ kind: 'idle' });
    });
  }, []);

  // Subscribe to the Firestore user profile (subscription state, tier,
  // allowance). Updates immediately when the Stripe webhook lands.
  useEffect(() => {
    return onUserProfileChanged(setUserProfile);
  }, []);

  // Subscribe to the current month's usage counters. Surfaced inline
  // alongside the plan label so the user sees their consumption next
  // to their cap without a separate UI surface.
  useEffect(() => {
    return onUsageThisMonthChanged(setUsage);
  }, []);

  // Listen for the Stripe checkout return-to-loopback. When the URL
  // path is `/checkout-success` we wait for the webhook to update
  // Firestore (the profile listener above will flip the UI). Cancel
  // path resets the subscribe-button state so the user can retry.
  useEffect(() => {
    return window.optix.stripe.onCheckoutCallback((url) => {
      try {
        const path = new URL(url).pathname;
        if (path === '/checkout-success') {
          // Don't clear subscribeStatus yet — the pricing cards stay
          // disabled until userProfile.subscriptionStatus flips, which
          // tells us the webhook actually fired. Until then the
          // "awaiting webhook" message is the right UX.
          setSubscribeStatus((prev) =>
            prev.kind === 'opening' || prev.kind === 'awaiting'
              ? { kind: 'awaiting', tier: prev.tier }
              : prev,
          );
        } else if (path === '/checkout-cancel') {
          setSubscribeStatus({ kind: 'idle' });
        }
      } catch {
        // Malformed URL — ignore. The watchdog tears down the loopback.
      }
    });
  }, []);

  // Once the user's subscriptionStatus flips to active and the tier
  // matches what they just bought, dismiss the "awaiting" UI.
  useEffect(() => {
    if (subscribeStatus.kind !== 'awaiting') return;
    if (
      userProfile?.subscriptionStatus === 'active' &&
      userProfile.tier === subscribeStatus.tier
    ) {
      setSubscribeStatus({ kind: 'idle' });
    }
  }, [subscribeStatus, userProfile]);

  // Re-check key status whenever the active provider changes.
  useEffect(() => {
    setKeyInput('');
    setStatus({ kind: 'unknown' });
    void window.optix.settings.hasApiKey(activeId).then((has) => {
      setStatus({ kind: has ? 'stored' : 'missing' });
    });
  }, [activeId]);

  useEffect(() => {
    if (isCustomModel) setCustomModel(currentModelId);
  }, [isCustomModel, currentModelId]);

  async function patchSettings(patch: Partial<Settings>) {
    await window.optix.settings.set(patch);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    await window.optix.settings.setApiKey(activeId, keyInput.trim());
    setKeyInput('');
    setStatus({ kind: 'stored' });
  }

  async function deleteKey() {
    await window.optix.settings.deleteApiKey(activeId);
    setStatus({ kind: 'missing' });
  }

  async function testKey() {
    setStatus({ kind: 'testing' });
    const result = await window.optix.provider.testKey(activeId);
    if (result.ok) setStatus({ kind: 'ok' });
    else setStatus({ kind: 'error', message: result.error });
  }

  async function startSignIn() {
    const email = emailInput.trim();
    if (!email) return;
    setSignInStatus({ kind: 'sending' });
    try {
      await sendSignInLink(email);
      setSignInStatus({ kind: 'sent', email });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSignInStatus({ kind: 'error', message });
    }
  }

  async function cancelInProgressSignIn() {
    await cancelSignIn();
    setSignInStatus({ kind: 'idle' });
  }

  async function doSignOut() {
    await signOutOptixCloud();
    // The auth-state observer will null out signedInUser; clear the
    // email input proactively so the next sign-in starts clean.
    setEmailInput('');
  }

  async function startSubscribe(tier: 'starter' | 'pro') {
    setSubscribeStatus({ kind: 'opening', tier });
    try {
      const token = await getFreshIdToken();
      if (!token) {
        setSubscribeStatus({
          kind: 'error',
          message: 'Sign-in expired. Sign in again.',
        });
        return;
      }
      await window.optix.stripe.startCheckout({ tier, authToken: token });
      // Browser is now showing Stripe Checkout. Stay in the 'opening'
      // state until the loopback callback fires; if the user just
      // closes the browser tab without completing, the watchdog tears
      // down the loopback and the user can retry.
      setSubscribeStatus({ kind: 'awaiting', tier });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubscribeStatus({ kind: 'error', message });
    }
  }

  async function cancelSubscribe() {
    await window.optix.stripe.cancelCheckout();
    setSubscribeStatus({ kind: 'idle' });
  }

  function onModelChange(modelId: string) {
    void patchSettings({
      modelByProvider: { ...settings.modelByProvider, [activeId]: modelId },
    });
  }

  if (view === 'audit') {
    return (
      <div className="settings-panel">
        <AuditLogViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  if (view === 'chat') {
    return (
      <div className="settings-panel">
        <ChatHistoryViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  if (view === 'routines') {
    return (
      <div className="settings-panel">
        <RoutinesViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <button type="button" className="btn btn--small" onClick={onClose}>
          ← Back
        </button>
        <strong>Settings</strong>
        <div className="settings-panel__header-actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('chat')}
          >
            Ask Logs
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('audit')}
          >
            Access Logs
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('routines')}
          >
            Automations
          </button>
        </div>
      </div>

      <div className="settings-panel__body">
        <section className="settings-panel__section">
          <label className="settings-panel__label">Provider</label>
          <div className="settings-panel__radios">
            {PROVIDER_IDS.map((id) => (
              <label key={id} className="settings-panel__radio">
                <input
                  type="radio"
                  name="activeProvider"
                  value={id}
                  checked={activeId === id}
                  onChange={() => void patchSettings({ activeProviderId: id })}
                />
                <span>{PROVIDER_LABELS[id]}</span>
              </label>
            ))}
          </div>
        </section>

        {activeId !== 'optixCloud' && (
          <section className="settings-panel__section">
            <label className="settings-panel__label">Model</label>
            <select
              className="settings-panel__input"
              value={isCustomModel ? '__custom__' : currentModelId}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  onModelChange(customModel || '');
                } else {
                  onModelChange(e.target.value);
                }
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.note ? ` — ${m.note}` : ''}
                </option>
              ))}
              <option value="__custom__">Custom model ID…</option>
            </select>
            {isCustomModel && (
              <input
                type="text"
                className="settings-panel__input settings-panel__input--mono"
                placeholder="provider-specific model id"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  onModelChange(e.target.value);
                }}
              />
            )}
          </section>
        )}

        {activeId === 'optixCloud' ? (
          <OptixCloudSection
            signedInUser={signedInUser}
            userProfile={userProfile}
            usage={usage}
            emailInput={emailInput}
            setEmailInput={setEmailInput}
            signInStatus={signInStatus}
            startSignIn={() => void startSignIn()}
            cancelInProgressSignIn={() => void cancelInProgressSignIn()}
            doSignOut={() => void doSignOut()}
            subscribeStatus={subscribeStatus}
            startSubscribe={(tier) => void startSubscribe(tier)}
            cancelSubscribe={() => void cancelSubscribe()}
          />
        ) : (
          <section className="settings-panel__section">
            <label className="settings-panel__label">{PROVIDER_LABELS[activeId]} API key</label>
            <div className="settings-panel__row">
              <input
                type="password"
                placeholder={
                  status.kind === 'stored' || status.kind === 'ok'
                    ? '•••••••• (stored in keychain)'
                    : 'Paste API key'
                }
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                className="settings-panel__input"
              />
              <button type="button" className="btn btn--small" onClick={saveKey} disabled={!keyInput.trim()}>
                Save
              </button>
              {(status.kind === 'stored' || status.kind === 'ok' || status.kind === 'error') && (
                <>
                  <button type="button" className="btn btn--small" onClick={testKey}>
                    Test
                  </button>
                  <button type="button" className="btn btn--small" onClick={deleteKey}>
                    Remove
                  </button>
                </>
              )}
            </div>
            <KeyStatusLine status={status} />
          </section>
        )}

        <section className="settings-panel__section">
          <label className="settings-panel__label">Hotkey</label>
          <input
            type="text"
            className="settings-panel__input settings-panel__input--mono"
            value={settings.hotkeyToggleWidget}
            onChange={(e) => void patchSettings({ hotkeyToggleWidget: e.target.value })}
            placeholder="e.g. Ctrl+Shift+Space"
          />
        </section>

        <section className="settings-panel__section">
          <div className="settings-panel__toggle-grid">
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.privacyPaused}
                onChange={() => void patchSettings({ privacyPaused: !settings.privacyPaused })}
              />
              <span>Pause capture</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.webSearchEnabled}
                onChange={() => void patchSettings({ webSearchEnabled: !settings.webSearchEnabled })}
              />
              <span>Web search</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.overlayEnabled}
                onChange={() => void patchSettings({ overlayEnabled: !settings.overlayEnabled })}
              />
              <span>Show overlay</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.conversationMode}
                onChange={() => void patchSettings({ conversationMode: !settings.conversationMode })}
              />
              <span>Conversation</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.theme === 'light'}
                onChange={() =>
                  void patchSettings({
                    theme: settings.theme === 'light' ? 'dark' : 'light',
                  })
                }
              />
              <span>Light mode</span>
            </label>
          </div>
        </section>

        <section className="settings-panel__section">
          <h3 className="settings-panel__section-title">Agent (Action mode)</h3>
          <div className="settings-panel__field-row">
            <label className="settings-panel__field">
              <span>Approval before actions</span>
              <select
                value={settings.agentApprovalMode}
                onChange={(e) =>
                  void patchSettings({
                    agentApprovalMode: e.target.value as 'per-task' | 'each-action' | 'never',
                  })
                }
              >
                <option value="per-task">Per task</option>
                <option value="each-action">Per action</option>
                <option value="never">Never</option>
              </select>
            </label>
            <label className="settings-panel__field">
              <span>Cost ceiling (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="No cap"
                value={settings.agentCostCeilingUsd ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const num = raw === '' ? null : Number(raw);
                  if (num !== null && !Number.isFinite(num)) return;
                  void patchSettings({ agentCostCeilingUsd: num });
                }}
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

function KeyStatusLine({ status }: { status: KeyStatus }) {
  if (status.kind === 'unknown') return null;
  if (status.kind === 'missing')
    return <div className="settings-panel__status settings-panel__status--muted">No key stored.</div>;
  if (status.kind === 'stored')
    return <div className="settings-panel__status settings-panel__status--ok">Key stored. Test it to verify.</div>;
  if (status.kind === 'testing')
    return <div className="settings-panel__status">Testing…</div>;
  if (status.kind === 'ok')
    return <div className="settings-panel__status settings-panel__status--ok">✓ Key works.</div>;
  return <div className="settings-panel__status settings-panel__status--error">✗ {status.message}</div>;
}

/** Renders the Optix Cloud-specific configuration block. Three states:
 *  - Signed out → email + send-link form
 *  - Signed in, no active subscription → pricing cards + Subscribe
 *  - Signed in, active subscription → plan info + Sign out
 *
 *  Kept inline rather than a separate file because all of its state is
 *  managed in the parent and threaded through props — splitting would
 *  just trade a section of JSX for a long props interface. */
function OptixCloudSection({
  signedInUser,
  userProfile,
  usage,
  emailInput,
  setEmailInput,
  signInStatus,
  startSignIn,
  cancelInProgressSignIn,
  doSignOut,
  subscribeStatus,
  startSubscribe,
  cancelSubscribe,
}: {
  signedInUser: { email: string } | null;
  userProfile: UserProfile | null;
  usage: UsageThisMonth | null;
  emailInput: string;
  setEmailInput: (s: string) => void;
  signInStatus: SignInStatus;
  startSignIn: () => void;
  cancelInProgressSignIn: () => void;
  doSignOut: () => void;
  subscribeStatus: SubscribeStatus;
  startSubscribe: (tier: 'starter' | 'pro') => void;
  cancelSubscribe: () => void;
}) {
  // Not signed in → magic-link sign-in form (same as before the
  // subscription work landed).
  if (!signedInUser) {
    return (
      <section className="settings-panel__section">
        <label className="settings-panel__label">Optix Cloud sign-in</label>
        <div className="settings-panel__row">
          <input
            type="email"
            placeholder="you@example.com"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            className="settings-panel__input"
            disabled={
              signInStatus.kind === 'sending' || signInStatus.kind === 'sent'
            }
          />
          {signInStatus.kind === 'sent' ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={cancelInProgressSignIn}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--small"
              onClick={startSignIn}
              disabled={
                !emailInput.trim() || signInStatus.kind === 'sending'
              }
            >
              {signInStatus.kind === 'sending'
                ? 'Sending…'
                : 'Send sign-in link'}
            </button>
          )}
        </div>
        <SignInStatusLine status={signInStatus} />
      </section>
    );
  }

  // Signed in + active subscription → vertical plan summary + actions.
  // Layout (top → bottom):
  //   1. account email
  //   2. plan + token count + renews/ends-on
  //   3. upgrade/cancel-status prompt (when applicable)
  //   4. action buttons: [Switch plan] [Cancel|Reactivate] [Sign out]
  //
  // We also render this view for `past_due` so the user gets actionable
  // controls (Switch plan retries the card with Stripe) rather than the
  // misleading pricing-card "subscribe again" path.
  const isActive = userProfile?.subscriptionStatus === 'active';
  const isPastDue = userProfile?.subscriptionStatus === 'past_due';
  if ((isActive || isPastDue) && userProfile?.tier) {
    return (
      <ActivePlanView
        signedInUser={signedInUser}
        userProfile={userProfile}
        usage={usage}
        doSignOut={doSignOut}
      />
    );
  }

  // Signed in but no active subscription (new user, cancelled, past_due).
  // Show the two pricing cards. `past_due` users see a heads-up so they
  // know why their access is gated.
  return (
    <section className="settings-panel__section">
      <div className="settings-panel__pricing-header">
        <label className="settings-panel__label">Optix Cloud</label>
        <button
          type="button"
          className="btn btn--small"
          onClick={doSignOut}
        >
          Sign out
        </button>
      </div>
      <div className="settings-panel__pricing-status">
        Signed in as <strong>{signedInUser.email}</strong>. Pick a plan to
        unlock Optix Cloud — billed monthly, cancel anytime.
        {userProfile?.subscriptionStatus === 'past_due' && (
          <div className="settings-panel__status settings-panel__status--error">
            Your last payment failed. Subscribing again will retry it.
          </div>
        )}
      </div>
      <div className="pricing-cards">
        {PLANS.map((plan) => (
          <PricingCard
            key={plan.tier}
            plan={plan}
            subscribeStatus={subscribeStatus}
            onSubscribe={() => startSubscribe(plan.tier)}
          />
        ))}
      </div>
      {(subscribeStatus.kind === 'opening' ||
        subscribeStatus.kind === 'awaiting') && (
        <div className="settings-panel__pricing-footer">
          <span>
            {subscribeStatus.kind === 'opening'
              ? 'Opening Stripe Checkout in your browser…'
              : 'Complete payment in your browser. We’ll unlock automatically when Stripe confirms.'}
          </span>
          <button type="button" className="btn btn--small" onClick={cancelSubscribe}>
            Cancel
          </button>
        </div>
      )}
      {subscribeStatus.kind === 'error' && (
        <div className="settings-panel__status settings-panel__status--error">
          ✗ {subscribeStatus.message}
        </div>
      )}
    </section>
  );
}

/** Active-subscription view for signed-in, paid users. Local state
 *  (`manageStatus`) tracks in-flight plan-switch / cancel / reactivate
 *  calls; the underlying Firestore profile listener flips the displayed
 *  state when the Stripe webhook reflects each change. */
function ActivePlanView({
  signedInUser,
  userProfile,
  usage,
  doSignOut,
}: {
  signedInUser: { email: string };
  userProfile: UserProfile;
  usage: UsageThisMonth | null;
  doSignOut: () => void;
}) {
  type ManageStatus =
    | { kind: 'idle' }
    | { kind: 'busy'; action: 'switchPlan' | 'cancel' | 'reactivate' }
    | { kind: 'error'; message: string };
  const [manageStatus, setManageStatus] = useState<ManageStatus>({ kind: 'idle' });

  const tier = userProfile.tier ?? 'starter';
  const tierLabel = tier === 'pro' ? 'Pro' : 'Starter';
  const otherTier: 'starter' | 'pro' = tier === 'pro' ? 'starter' : 'pro';
  const otherTierLabel = otherTier === 'pro' ? 'Pro' : 'Starter';
  const allowance = userProfile.tokenAllowanceMonthly;
  const used = usage?.totalTokens ?? 0;
  const periodEndDate = userProfile.currentPeriodEnd
    ? new Date(userProfile.currentPeriodEnd)
    : null;
  const cancelAtPeriodEnd = Boolean(userProfile.cancelAtPeriodEnd);

  async function callUpdate(
    action: 'switchPlan' | 'cancel' | 'reactivate',
    extra: Partial<{ tier: 'starter' | 'pro' }> = {},
  ) {
    setManageStatus({ kind: 'busy', action });
    try {
      const token = await getFreshIdToken();
      if (!token) throw new Error('Sign-in expired. Sign in again.');
      // Each branch is a separate object literal so TypeScript can
      // narrow the union — `extra` is only used by switchPlan. The
      // discriminated union schema in main rejects mismatches.
      if (action === 'switchPlan' && extra.tier) {
        await window.optix.stripe.updateSubscription({
          action: 'switchPlan',
          tier: extra.tier,
          authToken: token,
        });
      } else if (action === 'cancel') {
        await window.optix.stripe.updateSubscription({
          action: 'cancel',
          authToken: token,
        });
      } else if (action === 'reactivate') {
        await window.optix.stripe.updateSubscription({
          action: 'reactivate',
          authToken: token,
        });
      }
      // The Firestore onSnapshot listener will reflect the new state
      // once Stripe's webhook fires (~1s). Until then keep the busy
      // label so the user knows their click was received.
      setManageStatus({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setManageStatus({ kind: 'error', message });
    }
  }

  const isBusy = manageStatus.kind === 'busy';

  // Open Stripe's hosted billing portal. We don't track the
  // "opening" state in `manageStatus` because the portal lives in
  // the user's browser — they're not "busy on Optix" while it's open;
  // they could click other Settings buttons too. Failures here surface
  // through the manageStatus error path so the user sees them.
  async function openPortal() {
    try {
      const token = await getFreshIdToken();
      if (!token) {
        setManageStatus({
          kind: 'error',
          message: 'Sign-in expired. Sign in again.',
        });
        return;
      }
      await window.optix.stripe.openCustomerPortal({ authToken: token });
      // Browser is now showing the portal. Clear any prior error so
      // the row doesn't show stale state.
      setManageStatus({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setManageStatus({ kind: 'error', message });
    }
  }

  // Row 3 copy: depends on the subscription status, cancel-pending
  // state, and tier. `past_due` takes precedence over the others — if
  // the card just failed, that's the most important thing for the user
  // to know about and act on. We only show an upgrade prompt for
  // Starter → Pro since "downgrade to Starter to save money" isn't a
  // prompt we want to push.
  let prompt: { tone: 'info' | 'warn'; message: string } | null = null;
  if (userProfile.subscriptionStatus === 'past_due') {
    prompt = {
      tone: 'warn',
      message:
        'Your last payment failed. Update your payment method to keep your access — try Upgrade/Downgrade to retry billing.',
    };
  } else if (cancelAtPeriodEnd && periodEndDate) {
    prompt = {
      tone: 'warn',
      message: `Subscription ends on ${periodEndDate.toLocaleDateString()}. Reactivate to keep your access.`,
    };
  } else if (tier === 'starter') {
    // Source price from the same PLANS catalog the pricing cards use,
    // so changing the tier price in one place updates this nudge too.
    const proPlan = PLANS.find((p) => p.tier === 'pro');
    prompt = {
      tone: 'info',
      message: `Upgrade to Pro — 15M tokens for ${proPlan?.price ?? '$99 / month'}.`,
    };
  }

  // Renewal / end date copy lives on a `title` tooltip attached to
  // the plan label — keeps the visible row compact while still letting
  // the user hover-confirm when the next charge (or cut-off) is.
  const tooltipText = periodEndDate
    ? `${cancelAtPeriodEnd ? 'Access ends' : 'Renews'} ${periodEndDate.toLocaleDateString()}`
    : undefined;

  return (
    <section className="settings-panel__section">
      <label className="settings-panel__label">Optix Cloud</label>
      {/* Row 1: account email (bold, reads as identity anchor) +
          plan label with renewal-date tooltip + monthly token usage.
          All three are read-only state; clustering them on one row
          keeps the active-subscription view compact. */}
      <div className="settings-panel__plan-row settings-panel__plan-row--header">
        <span className="settings-panel__plan-email">{signedInUser.email}</span>
        <span
          className="settings-panel__plan-tier"
          title={tooltipText}
          aria-label={tooltipText}
        >
          {tierLabel} plan
          {/* The little ⓘ glyph signals the tooltip is there for users
              who don't think to hover the text. Pure visual hint —
              the tooltip itself fires on the whole span. */}
          {tooltipText && <span className="settings-panel__plan-tier-info">ⓘ</span>}
        </span>
        <span className="settings-panel__usage">
          {formatTokens(used)} / {allowance ? formatTokens(allowance) : '—'}
        </span>
      </div>
      {/* Row 2: prompt — upgrade nudge or cancellation/past_due warning. */}
      {prompt && (
        <div
          className={`settings-panel__plan-prompt settings-panel__plan-prompt--${prompt.tone}`}
        >
          {prompt.message}
        </div>
      )}
      {manageStatus.kind === 'error' && (
        <div className="settings-panel__status settings-panel__status--error">
          ✗ {manageStatus.message}
        </div>
      )}
      {/* Row 3: action buttons. Order from left to right reads as
          "least → most disruptive": billing maintenance, then plan
          mutation, then cancellation, then session-end. Sign Out stays
          rightmost so muscle memory from the prior layout is preserved. */}
      <div className="settings-panel__plan-actions">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void openPortal()}
          disabled={isBusy}
          title="Update your card or view invoices on Stripe."
        >
          Update Payment Method
        </button>
        {!cancelAtPeriodEnd && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void callUpdate('switchPlan', { tier: otherTier })}
            disabled={isBusy}
          >
            {/* Direction-aware label: Pro is the bigger tier, so
                Starter→Pro is "Upgrade" and Pro→Starter is "Downgrade".
                In-flight copy mirrors the direction so the user sees
                exactly what they triggered. */}
            {isBusy && manageStatus.action === 'switchPlan'
              ? otherTier === 'pro'
                ? 'Upgrading Plan…'
                : 'Downgrading Plan…'
              : otherTier === 'pro'
                ? 'Upgrade Plan'
                : 'Downgrade Plan'}
          </button>
        )}
        {cancelAtPeriodEnd ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void callUpdate('reactivate')}
            disabled={isBusy}
          >
            {isBusy && manageStatus.action === 'reactivate'
              ? 'Reactivating…'
              : 'Reactivate'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void callUpdate('cancel')}
            disabled={isBusy}
          >
            {isBusy && manageStatus.action === 'cancel'
              ? 'Cancelling…'
              : 'Cancel Plan'}
          </button>
        )}
        <button
          type="button"
          className="btn btn--small"
          onClick={doSignOut}
          disabled={isBusy}
        >
          Sign out
        </button>
      </div>
    </section>
  );
}

function PricingCard({
  plan,
  subscribeStatus,
  onSubscribe,
}: {
  plan: Plan;
  subscribeStatus: SubscribeStatus;
  onSubscribe: () => void;
}) {
  // Disable the OTHER card's button when one is mid-checkout — prevents
  // the user from kicking off two flows at once (which would tear down
  // the first loopback and confuse Stripe). The active card's button
  // also disables itself but shows the in-flight label.
  const isThisInFlight =
    (subscribeStatus.kind === 'opening' || subscribeStatus.kind === 'awaiting') &&
    subscribeStatus.tier === plan.tier;
  const isAnyInFlight =
    subscribeStatus.kind === 'opening' || subscribeStatus.kind === 'awaiting';

  return (
    <div className={`pricing-card${plan.tier === 'pro' ? ' pricing-card--featured' : ''}`}>
      <div className="pricing-card__header">
        <strong className="pricing-card__name">{plan.label}</strong>
        <span className="pricing-card__price">{plan.price}</span>
      </div>
      <p className="pricing-card__blurb">{plan.blurb}</p>
      <ul className="pricing-card__features">
        {plan.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <button
        type="button"
        className="btn pricing-card__cta"
        onClick={onSubscribe}
        disabled={isAnyInFlight}
      >
        {isThisInFlight
          ? subscribeStatus.kind === 'opening'
            ? 'Opening…'
            : 'Awaiting payment…'
          : `Subscribe to ${plan.label}`}
      </button>
    </div>
  );
}

/** Compact token formatter — millions get an "M" suffix so the inline
 *  usage label stays one line wide ("1.2M / 5M" not "1,234,567 /
 *  5,000,000"). Below 1k we render the raw integer; below 1M we use
 *  k. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function SignInStatusLine({ status }: { status: SignInStatus }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'sending')
    return <div className="settings-panel__status">Sending sign-in link…</div>;
  if (status.kind === 'sent')
    return (
      <div className="settings-panel__status settings-panel__status--ok">
        Link sent to {status.email}. Click it in your inbox — sign-in completes automatically when you do.
      </div>
    );
  return <div className="settings-panel__status settings-panel__status--error">✗ {status.message}</div>;
}
