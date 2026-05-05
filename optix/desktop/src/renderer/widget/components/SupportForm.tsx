import { useState } from 'react';

// Email this form sends to. Centralised here so renaming the destination
// (e.g. moving to a dedicated support@ address later) is a one-line edit.
const SUPPORT_EMAIL = 'admin@covetable.com.au';

// App version — injected at build time from `optix/desktop/package.json`
// via electron-vite's `define` config (see `electron.vite.config.ts`).
// Always accurate after every release without a hand-maintained const.
const APP_VERSION: string = __APP_VERSION__;

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

type Props = {
  /** Provider currently active in the widget — surfaced in the email
   *  diagnostics block so we can reproduce issues that depend on which
   *  model was in play. Optional because the docs viewer might be
   *  opened before any provider is configured. */
  activeProvider?: string;
  /** Optix Cloud user email if signed in. Pre-fills the "your email"
   *  field so the user doesn't have to retype. */
  signedInEmail?: string;
};

/** Inline support form. Submitting opens the user's default mail client
 *  with a pre-filled message — no backend dependency, works offline,
 *  works on every OS Electron supports.
 *
 *  Diagnostic info (app version, platform string, active provider) is
 *  appended to the body so support can reproduce issues without a
 *  back-and-forth. The user can edit before sending. */
export function SupportForm({ activeProvider, signedInEmail }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(signedInEmail ?? '');
  const [category, setCategory] = useState<Category>('Bug report');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);

  const canSubmit =
    subject.trim().length > 0 && message.trim().length > 0 && !submittedAt;

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!canSubmit) return;

    // Diagnostic block appended below the user's message. Keeps the user's
    // own copy untouched and gives support a reproducible context block.
    const diagnostics = [
      `App version: ${APP_VERSION}`,
      `Platform: ${navigator.userAgent}`,
      `Locale: ${navigator.language}`,
      activeProvider ? `Active provider: ${activeProvider}` : null,
      signedInEmail ? `Optix Cloud account: ${signedInEmail}` : null,
      `Submitted: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    const body =
      [
        name ? `From: ${name}` : null,
        email ? `Reply to: ${email}` : null,
        `Category: ${category}`,
        '',
        message,
        '',
        '---',
        'Diagnostics (auto-included):',
        diagnostics,
      ]
        .filter((line) => line !== null)
        .join('\n');

    // mailto: spec is fussy about line breaks. Use %0D%0A (CRLF) per RFC
    // 6068; some clients also accept %0A but Outlook/Mail are strict.
    const mailto =
      `mailto:${encodeURIComponent(SUPPORT_EMAIL)}` +
      `?subject=${encodeURIComponent(`[${category}] ${subject}`)}` +
      `&body=${encodeURIComponent(body).replace(/%20/g, '%20')}`;

    // Use window.location.href = mailto over <a> click — works inside
    // an Electron sandboxed renderer where window.open might be blocked
    // by our setWindowOpenHandler (which routes most opens through
    // safeOpenExternal). mailto: is whitelisted by the OS handler.
    window.location.href = mailto;
    setSubmittedAt(Date.now());
  };

  if (submittedAt) {
    return (
      <div className="support-form support-form--sent">
        <p>
          Your message has been opened in your email client. Click <strong>Send</strong> there to deliver it to {SUPPORT_EMAIL}.
        </p>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            setSubmittedAt(null);
            setSubject('');
            setMessage('');
          }}
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <form className="support-form" onSubmit={handleSubmit}>
      <label className="support-form__row">
        <span className="support-form__label">Your name <em>(optional)</em></span>
        <input
          type="text"
          className="support-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoComplete="name"
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
        />
      </label>

      <label className="support-form__row">
        <span className="support-form__label">Category</span>
        <select
          className="support-form__input"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
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
        />
        <span className="support-form__counter">
          {message.length} / 4000
        </span>
      </label>

      <div className="support-form__actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!canSubmit}
        >
          Open in email client
        </button>
      </div>
    </form>
  );
}
