// Support form submission. The renderer's "Getting help" article posts
// here; we forward to the Cloud Functions relay (`submitFeedback`) which
// sends the email via nodemailer using SMTP credentials stored in
// Firebase secrets — never in the desktop bundle. The form falls back
// to a mailto: link (opened via main-process `shell.openExternal` to
// bypass the widget's navigation guard) if the relay is unreachable or
// returns an error.
//
// Auth: optional. Optix Cloud users include a fresh Firebase ID token
// so the relay can correlate the message with their account; BYO-key
// users submit anonymously. Anonymous submissions are still allowed,
// but the Cloud Function should rate-limit them (see the deployment
// notes in the Cloud Functions repo).

import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  FeedbackSubmissionSchema,
  type FeedbackSubmissionResult,
} from '@shared/schemas';

const SUBMIT_FEEDBACK_URL =
  'https://us-central1-optix-22473.cloudfunctions.net/submitFeedback';

// Soft-cap the relay request — feedback should be quick. If the
// Cloud Function is slow or unreachable, fall back to mailto rather
// than spinning the form's loading state forever.
const RELAY_TIMEOUT_MS = 15_000;

const OpenMailtoRequestSchema = z
  .object({
    to: z.string().email().max(320),
    subject: z.string().max(140),
    body: z.string().max(8000),
  })
  .strict();

export function registerFeedbackIpc(): void {
  ipcMain.handle(IPC.feedback.submit, async (_event, raw: unknown): Promise<FeedbackSubmissionResult> => {
    let req;
    try {
      req = FeedbackSubmissionSchema.parse(raw);
    } catch (err) {
      console.warn('[optix-feedback] payload validation failed:', err);
      return {
        ok: false,
        error: 'Invalid form data. Please refresh and try again.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (req.authToken) {
        headers.authorization = `Bearer ${req.authToken}`;
      }
      // Strip authToken from the body — it's already in the header. The
      // relay reads it from `Authorization` for consistency with the
      // other Cloud Functions endpoints.
      const { authToken: _drop, ...body } = req;
      void _drop;

      const res = await fetch(SUBMIT_FEEDBACK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Don't leak relay error details to the renderer — they could
        // contain stack traces or internal paths. Log internally,
        // surface a stable user-facing message.
        const text = await res.text().catch(() => '');
        console.warn(
          `[optix-feedback] relay returned ${res.status}: ${text.slice(0, 200)}`,
        );
        return {
          ok: false,
          error:
            res.status === 429
              ? 'Too many submissions. Please wait a few minutes and try again.'
              : 'Could not reach support relay. Please try the email-client fallback.',
        };
      }

      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          error: 'Submission timed out. Please try the email-client fallback.',
        };
      }
      console.warn('[optix-feedback] relay request threw:', err);
      return {
        ok: false,
        error: 'Network error reaching support relay.',
      };
    } finally {
      clearTimeout(timer);
    }
  });

  // Fallback path — opens the user's default mail client with a
  // pre-filled message. Renderer's own `window.location.href = mailto:`
  // is blocked by the widget's `will-navigate` guard, so we route the
  // open through main's `shell.openExternal`. We don't go through
  // `safeOpenExternal` because that filter is for agent-supplied URLs
  // (intentionally http(s)-only); this path is only reachable from our
  // trusted renderer code.
  ipcMain.handle(IPC.feedback.openMailto, async (_event, raw: unknown): Promise<void> => {
    const { to, subject, body } = OpenMailtoRequestSchema.parse(raw);
    // Build the mailto URL with proper percent-encoding. mailto RFC 6068
    // says CRLF for line breaks; some clients (Outlook, Apple Mail) are
    // strict about this.
    const mailto =
      `mailto:${encodeURIComponent(to)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    try {
      await shell.openExternal(mailto);
    } catch (err) {
      // openExternal can throw on platforms with no registered mail
      // handler. Log + swallow — renderer will surface a manual
      // "copy email address" affordance as a last resort.
      console.warn('[optix-feedback] shell.openExternal(mailto) failed:', err);
      throw new Error('Could not open the email client.');
    }
  });

}
