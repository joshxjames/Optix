// Firebase Auth (renderer side) for the Optix Cloud sign-in flow.
//
// Why this lives in the renderer, not main: the Firebase JS SDK keeps
// auth state in IndexedDB inside its own browser context, and the
// `getIdToken()` auto-refresh logic is part of that same SDK runtime.
// Putting it here means we get persistence, refresh, and signOut for
// free — main never touches a Firebase token directly. The renderer
// fetches a fresh ID token before each IPC call to the main process and
// hands it across as `authToken`.

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getFirestore,
  onSnapshot,
  type DocumentData,
} from 'firebase/firestore';

// Public client identifiers — Firebase explicitly states these are not
// secrets. Real security comes from Firestore rules + the relay's
// server-side ID-token verification.
const firebaseConfig = {
  apiKey: 'AIzaSyCpHCej59fYjyxbbWufE3w99ix_zHfXQgU',
  authDomain: 'optix-22473.firebaseapp.com',
  projectId: 'optix-22473',
  storageBucket: 'optix-22473.firebasestorage.app',
  messagingSenderId: '710686126940',
  appId: '1:710686126940:web:c6c1ee2840f4d979f24799',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Firebase requires the *same* email used to send the link to be passed
// into `signInWithEmailLink`. We stash it in main-process memory (via
// the `auth.setPendingEmail` / `consumePendingEmail` IPC channels)
// between the 'Send link' click and the loopback callback. Storing it
// in renderer localStorage would let any malicious JS already in the
// renderer overwrite it mid-flow to complete sign-in as a different
// account.

let loopbackUnsub: (() => void) | null = null;

/** Lazy installer for the global loopback callback subscription. We
 *  attach it the first time the user starts a sign-in, then re-use it
 *  for the lifetime of the page — Firebase's auth state observer cleans
 *  up the rest after the email link is consumed. */
function ensureLoopbackSubscription(): void {
  if (loopbackUnsub) return;
  loopbackUnsub = window.optix.auth.onLoopbackCallback(async (url) => {
    try {
      // Verify the URL really is a Firebase sign-in link before we hand
      // it to `signInWithEmailLink` — guards against stray hits to the
      // loopback server (browser autofill, accidental probe).
      if (!isSignInWithEmailLink(auth, url)) {
        console.warn('[optix-auth] callback URL is not a Firebase sign-in link');
        await window.optix.auth.stopLoopback();
        return;
      }
      const { email } = await window.optix.auth.consumePendingEmail();
      if (!email) {
        console.warn('[optix-auth] no pending email; cannot complete sign-in');
        await window.optix.auth.stopLoopback();
        return;
      }
      await signInWithEmailLink(auth, email, url);
    } catch (err) {
      console.error('[optix-auth] sign-in callback failed:', err);
    } finally {
      // The loopback server already shut itself down after answering
      // the callback, but call stop again as a belt-and-braces in case
      // the server's listener fired twice.
      await window.optix.auth.stopLoopback().catch(() => {});
    }
  });
}

/** Send a magic sign-in link to `email`. Spins up the loopback server
 *  first so the link's `continueUrl` points at us. The user clicks the
 *  link in their email; the loopback callback fires and we complete the
 *  sign-in automatically. */
export async function sendSignInLink(email: string): Promise<void> {
  ensureLoopbackSubscription();
  const { port } = await window.optix.auth.startLoopback();
  const continueUrl = `http://127.0.0.1:${port}/callback`;

  // Stash the email so the eventual callback handler can complete the
  // flow — Firebase requires the same email be passed back.
  await window.optix.auth.setPendingEmail({ email });

  await sendSignInLinkToEmail(auth, email, {
    url: continueUrl,
    handleCodeInApp: true,
  });
}

/** Cancel an in-progress sign-in. Stops the loopback server and clears
 *  the pending-email stash. Safe to call when no flow is active. */
export async function cancelSignIn(): Promise<void> {
  await window.optix.auth.clearPendingEmail().catch(() => {});
  await window.optix.auth.stopLoopback().catch(() => {});
}

/** Subscribe to auth-state changes. Cb fires immediately with the
 *  current user (or null if signed out) and again on every change. */
export function onAuthChanged(
  cb: (user: { email: string; uid: string } | null) => void,
): () => void {
  return onAuthStateChanged(auth, (user: User | null) => {
    cb(user ? { email: user.email ?? '', uid: user.uid } : null);
  });
}

/** Fetch a fresh Firebase ID token. The SDK auto-refreshes if the
 *  current token is within ~5 min of expiry. Returns null when no user
 *  is signed in (renderer should treat that as "Optix Cloud needs
 *  sign-in"). */
export async function getFreshIdToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

/** Sign the current user out of Optix Cloud. Clears the SDK's persisted
 *  auth state. */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

/** Read-only snapshot of the current user, for UI rendering. Use
 *  `onAuthChanged` for reactive updates. */
export function currentUser(): { email: string; uid: string } | null {
  const u = auth.currentUser;
  return u ? { email: u.email ?? '', uid: u.uid } : null;
}

// ---------------------------------------------------------------------------
// User profile (Firestore `users/{uid}` doc)
// ---------------------------------------------------------------------------
//
// The relay's auth check + the renderer's pricing UI both need to know
// the user's subscription state, which lives at `users/{uid}` in
// Firestore. We subscribe with `onSnapshot` so the pricing page flips
// from "subscribe" → "subscribed" the instant the Stripe webhook lands
// — no polling, no manual refresh.

/** Shape we read off the user doc. The webhook writes more fields than
 *  this; we only surface what the renderer cares about. Everything's
 *  optional because new accounts haven't been touched by the webhook
 *  yet. */
// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type UserProfile = {
  email?: string | undefined;
  /** 'active' | 'past_due' | 'canceled' | 'none' | etc. The relay
   *  treats anything other than 'active' as locked. */
  subscriptionStatus?: string | undefined;
  /** 'starter' | 'pro' (or undefined when never subscribed). */
  tier?: 'starter' | 'pro' | undefined;
  /** Monthly token cap for the active tier. Mirrors what the relay
   *  enforces. Used to render a usage meter in Settings. */
  tokenAllowanceMonthly?: number | undefined;
  /** ISO string for when the current paid period ends (Firestore
   *  Timestamp serialised). UI shows "renews on…" / "access ends on…". */
  currentPeriodEnd?: string | undefined;
  /** True when the user has cancelled but is still inside the paid
   *  period — the subscription stays active until `currentPeriodEnd`,
   *  then auto-deletes. Drives the "ends on" copy + Reactivate button. */
  cancelAtPeriodEnd?: boolean | undefined;
};

/** Sum of input + output + cache tokens consumed in the current
 *  billing month. Mirrors the relay's enforcement basis: every counter
 *  on `users/{uid}/usage/{yyyymm}` summed equally. The webhook stores
 *  these via `FieldValue.increment` per request, so the renderer just
 *  reads the live total. */
export type UsageThisMonth = {
  /** Total tokens billed this month — what the relay's cap compares
   *  against. Sum of input/output/cache-create/cache-read counters. */
  totalTokens: number;
  /** Per-counter breakdown, in case the UI ever wants to show it
   *  separately. Currently only `totalTokens` is rendered. */
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  /** Number of relayed requests this month — useful as a sanity
   *  metric in dev. */
  requestCount: number;
};

/** UTC year-month key matching the relay's bucket layout
 *  (`users/{uid}/usage/{yyyy-mm}`). Same format as `monthKey()` in
 *  the Cloud Function — keep them in sync. */
function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Subscribe to live updates of `users/{currentUid}`. The cb fires
 *  immediately with the current snapshot data (or null if the user is
 *  signed out, or if the doc doesn't exist yet — new sign-ups have
 *  their doc seeded asynchronously by the `onUserCreate` trigger).
 *
 *  Returns an unsubscribe function. Re-resolves the uid on every auth
 *  state change so signing out + back in as a different user pulls
 *  the right doc. */
export function onUserProfileChanged(
  cb: (profile: UserProfile | null) => void,
): () => void {
  let docUnsub: (() => void) | null = null;

  const authUnsub = onAuthStateChanged(auth, (user) => {
    // Tear down the previous user's listener before attaching a new
    // one — without this, signing out then back in would leak the
    // first listener and double-invoke the callback.
    if (docUnsub) {
      docUnsub();
      docUnsub = null;
    }
    if (!user) {
      cb(null);
      return;
    }
    const ref = doc(db, 'users', user.uid);
    docUnsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          cb(null);
          return;
        }
        cb(toProfile(snap.data()));
      },
      (err) => {
        console.warn('[optix-firebase] user profile snapshot failed:', err);
        cb(null);
      },
    );
  });

  return () => {
    authUnsub();
    if (docUnsub) docUnsub();
  };
}

/** Subscribe to live updates of the current month's usage counters at
 *  `users/{uid}/usage/{yyyy-mm}`. Cb fires with zero counts when the
 *  doc doesn't exist yet (a freshly-subscribed user before they make
 *  their first request). Listener auto-rebinds when the auth state
 *  changes, same pattern as `onUserProfileChanged`. */
export function onUsageThisMonthChanged(
  cb: (usage: UsageThisMonth) => void,
): () => void {
  let docUnsub: (() => void) | null = null;

  const authUnsub = onAuthStateChanged(auth, (user) => {
    if (docUnsub) {
      docUnsub();
      docUnsub = null;
    }
    if (!user) {
      cb({
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      });
      return;
    }
    const ref = doc(db, 'users', user.uid, 'usage', currentMonthKey());
    docUnsub = onSnapshot(
      ref,
      (snap) => cb(toUsage(snap.exists() ? snap.data() : {})),
      (err) => {
        console.warn('[optix-firebase] usage snapshot failed:', err);
        cb(toUsage({}));
      },
    );
  });

  return () => {
    authUnsub();
    if (docUnsub) docUnsub();
  };
}

function toUsage(data: DocumentData): UsageThisMonth {
  // The relay reserves 50k tokens per in-flight request by incrementing
  // BOTH `inputTokens` AND `reservedTokens` up-front, then nets the
  // reservation back out when actual usage lands post-stream. Mid-flight
  // the raw `inputTokens` therefore inflates by `reservedTokens` worth
  // of phantom tokens — netting them out here gives the user a stable
  // "what I've actually used" reading instead of a meter that briefly
  // jumps by 50k per request and snaps back. Math invariant:
  // displayedInputTokens = max(0, rawInput − reservedTokens).
  const rawInputTokens = numberOrZero(data.inputTokens);
  const reservedTokens = numberOrZero(data.reservedTokens);
  const inputTokens = Math.max(0, rawInputTokens - reservedTokens);
  const outputTokens = numberOrZero(data.outputTokens);
  const cacheCreateTokens = numberOrZero(data.cacheCreateTokens);
  const cacheReadTokens = numberOrZero(data.cacheReadTokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    totalTokens:
      inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens,
    requestCount: numberOrZero(data.requestCount),
  };
}

function numberOrZero(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function toProfile(data: DocumentData): UserProfile {
  // Firestore Timestamps need explicit conversion to JS-friendly
  // strings; everything else passes through as-is.
  const periodEnd = data.currentPeriodEnd;
  const periodEndIso =
    periodEnd && typeof periodEnd.toDate === 'function'
      ? (periodEnd.toDate() as Date).toISOString()
      : undefined;
  return {
    email: typeof data.email === 'string' ? data.email : undefined,
    subscriptionStatus:
      typeof data.subscriptionStatus === 'string'
        ? data.subscriptionStatus
        : undefined,
    tier:
      data.tier === 'starter' || data.tier === 'pro' ? data.tier : undefined,
    tokenAllowanceMonthly:
      typeof data.tokenAllowanceMonthly === 'number'
        ? data.tokenAllowanceMonthly
        : undefined,
    currentPeriodEnd: periodEndIso,
    cancelAtPeriodEnd:
      typeof data.cancelAtPeriodEnd === 'boolean'
        ? data.cancelAtPeriodEnd
        : undefined,
  };
}
