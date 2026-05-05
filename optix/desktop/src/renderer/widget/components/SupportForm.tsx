import { useState } from 'react';
import { getFreshIdToken } from '../firebase';

// Email this form sends to. Centralised here so renaming the destination
// (e.g. moving to a dedicated support@ address later) is a one-line edit.
const SUPPORT_EMAIL = 'admin@covetable.com.au';

// App version — injected at build time from `optix/desktop/package.json`
// via electron-vite's `define` config (see `electron.vite.config.ts`).
//
// Defensive `typeof` access: in dev mode the `define` substitution
// sometimes doesn't propagate (e.g. when Vite's pre-bundled cache is
// stale), which would otherwise throw a ReferenceError at module load
// and cascade into the React tree as a render failure. `typeof` is
// special-cased to NOT throw on undeclared identifiers — it just
// returns 'undefined'. Production builds substitute the literal so
// the fallback path is never taken there.
const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

type Category =
  | 'Bug report'
  | 'Feature request'
  | 'Billing / Optix Cloud'
  | 'Question'
  | 'Other';

const CATEGORIES: Category[] = [
  'Bug report',
  'Feature request',
  'Billing / Optix Cloud',
  'Question',
  'Other',
];

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  /** Relay submission failed. We expose a "send via email client" button
   *  so the user can fall back gracefully — the message body is preserved
   *  so they don't lose what they typed. */
  | { kind: 'failed'; error: string };

type Props = {
  /** Provider currently active in the widget — surfaced in the email
   *  diagnostics block so we can reproduce issues that depend on which
   *  model was in play. Optional because the docs viewer might be
   *  opened before any provider is configured. */
  activeProvider?: string;
  /** Optix Cloud user email if signed in. Pre-fills the "your email"
   *  field, AND triggers an authenticated submission (we attach a fresh
   *  Firebase ID token to the relay request so it can correlate the
   *  message with the user's account). */
  signedInEmail?: string;
};

/** Inline support form. Submission flow:
 *
 *  1. POST form data to the `submitFeedback` Cloud Function via
 *     `window.optix.feedback.submit`. Cloud Function uses nodemailer +
 *     SMTP credentials stored in Firebase secrets to send an email
 *     to the support address.
 *  2. On success: show a "thanks, message sent" state.
 *  3. On failure (relay unreachable, 5xx, timeout): show an error
 *     message + offer a "Open in email client" fallback button. The
 *     fallback uses `shell.openExternal('mailto:...')` from main
 *     because the renderer's own `window.location.href = mailto:` is
 *     blocked by the widget's navigation guard.
 *
 *  Diagnostic info (app version, platform, locale, active provider,
 *  signed-in email) is auto-included in the email body so support can
 *  reproduce issues without a back-and-forth. */
export function SupportForm({ activeProvider, signedInEmail }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(signedInEmail ?? '');
  const [category, setCategory] = useState<Category>('Bug report');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const canSubmit =
    subject.trim().length > 0 &&
    message.trim().length > 0 &&
    status.kind !== 'sending' &&
    status.kind !== 'sent';

  /** Build the diagnostics block once — used both for the relay payload
   *  and the mailto fallback so the support inbox sees consistent
   *  context regardless of which path the message took. */
  const buildDiagnostics = () => ({
    appVersion: APP_VERSION,
    userAgent: navigator.userAgent.slice(0, 500),
    locale: navigator.language,
    ...(activeProvider !== undefined ? { activeProvider } : {}),
    ...(signedInEmail !== undefined ? { signedInEmail } : {}),
    submittedAt: new Date().toISOString(),
  });

  /** Render the diagnostics object as a plain-text block — used by the
   *  mailto fallback to embed the same context. */
  const diagnosticsAsText = (d: ReturnType<typeof buildDiagnostics>): string =>
    [
      `App version: ${d.appVersion}`,
      `Platform: ${d.userAgent}`,
      `Locale: ${d.locale}`,
      d.activeProvider ? `Active provider: ${d.activeProvider}` : null,
      d.signedInEmail ? `Optix Cloud account: ${d.signedInEmail}` : null,
      `Submitted: ${d.submittedAt}`,
    ]
      .filter(Boolean)
      .join('\n');

  const buildMailtoBody = (d: ReturnType<typeof buildDiagnostics>): string =>
    [
      name ? `From: ${name}` : null,
      email ? `Reply to: ${email}` : null,
      `Category: ${category}`,
      '',
      message,
      '',
      '---',
      'Diagnostics (auto-included):',
      diagnosticsAsText(d),
    ]
      .filter((line) => line !== null)
      .join('\n');

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus({ kind: 'sending' });

    const diagnostics = buildDiagnostics();

    // Fetch a fresh Firebase ID token if the user is signed into Optix
    // Cloud. Anonymous submissions are fine — the relay accepts them
    // (with rate-limiting) for BYO-key users who never sign in. Wrap
    // the token fetch in try/catch so a transient SDK hiccup doesn't
    // kill the submission entirely.
    let authToken: string | undefined;
    if (signedInEmail) {
      try {
        const tok = await getFreshIdToken();
        if (tok) authToken = tok;
      } catch {
        // best-effort — submit without auth, relay will treat as anon
      }
    }

    try {
      const result = await window.optix.feedback.submit({
        name,
        email: email || '',
        category,
        subject,
        message,
        diagnostics,
        ...(authToken !== undefined ? { authToken } : {}),
      });

      if (result.ok) {
        setStatus({ kind: 'sent' });
      } else {
        setStatus({ kind: 'failed', error: result.error });
      }
    } catch (err) {
      // IPC handler itself threw (validation error, etc.) — shouldn't
      // happen with a well-formed form, but guard anyway.
      const errMsg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'failed', error: errMsg });
    }
  };

  const handleMailtoFallback = async (): Promise<void> => {
    const diagnostics = buildDiagnostics();
    const body = buildMailtoBody(diagnostics);
    try {
      await window.optix.feedback.openMailto({
        to: SUPPORT_EMAIL,
        subject: `[${category}] ${subject}`,
        body,
      });
      setStatus({ kind: 'sent' });
    } catch {
      // Last-resort: leave the user the address to copy. Update the
      // status copy to surface the email so they can paste it manually
      // into whatever mail tool they have.
      setStatus({
        kind: 'failed',
        error: `Could not open an email client. Please email ${SUPPORT_EMAIL} directly.`,
      });
    }
  };

  const reset = (): void => {
    setStatus({ kind: 'idle' });
    setSubject('');
    setMessage('');
  };

  if (status.kind === 'sent') {
    return (
      <div className="support-form support-form--sent">
        <p>
          <strong>Thanks!</strong> Your message has been sent. We'll reply within 1–2 business days.
        </p>
        <button type="button" className="btn btn--small" onClick={reset}>
          Send another
        </button>
      </div>
    );
  }

  return (
    <form className="support-form" onSubmit={(e) => void handleSubmit(e)}>
      <label className="support-form__row">
        <span className="support-form__label">Your name <em>(optional)</em></span>
        <input
          type="text"
          className="support-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoComplete="name"
          disabled={status.kind === 'sending'}
        />
      </label>

      <label className="support-form__row">
        <span className="support-form__label">Reply-to email <em>(optional)</em></span>
        <input
          type="email"
          className="support-form__input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={320}
          autoComplete="email"
          placeholder={signedInEmail ? undefined : 'you@example.com'}
          disabled={status.kind === 'sending'}
        />
      </label>

      <label className="support-form__row">
        <span className="support-form__label">Category</span>
        <select
          className="support-form__input"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          disabled={status.kind === 'sending'}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="support-form__row">
        <span className="support-form__label">Subject</span>
        <input
          type="text"
          className="support-form__input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={140}
          required
          disabled={status.kind === 'sending'}
        />
      </label>

      <label className="support-form__row">
        <span className="support-form__label">Message</span>
        <textarea
          className="support-form__input support-form__textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={4000}
          rows={6}
          required
          placeholder="Describe the issue or request. Include steps to reproduce if it's a bug."
          disabled={status.kind === 'sending'}
        />
        <span className="support-form__counter">
          {message.length} / 4000
        </span>
      </label>

      {status.kind === 'failed' && (
        <div className="support-form__error">
          <strong>Couldn't send:</strong> {status.error}{' '}
          <button
            type="button"
            className="support-form__fallback-link"
            onClick={() => void handleMailtoFallback()}
          >
            Open in email client instead
          </button>
        </div>
      )}

      <div className="support-form__actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!canSubmit}
        >
          {status.kind === 'sending' ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </form>
  );
}
