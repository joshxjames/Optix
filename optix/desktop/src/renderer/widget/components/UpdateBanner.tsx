// Pinned banner that appears when a new Optix version has been
// downloaded in the background and is ready to install. The user
// clicks "Restart now" to apply (main calls `autoUpdater.quitAndInstall`
// which closes all windows and relaunches on the new version) or
// "Later" to dismiss for the rest of this session.
//
// Even if the user dismisses, the staged update applies automatically
// the next time they quit Optix normally — `autoInstallOnAppQuit` is
// on in main/updater.ts. So "Later" really means "not right this
// second", not "skip this update entirely".

import { useEffect, useState } from 'react';
import type { UpdateDownloadedInfo } from '../../../shared/api';

/** Clean up the renderer-side error message before showing it to the
 *  user. Electron's `ipcMain.handle` wraps thrown errors in the form
 *    "Error invoking remote method '<channel>': Error: <real cause>"
 *  before piping them across the boundary, which leaks IPC plumbing
 *  into user-visible text. Strip that wrapper, then map a few known
 *  electron-updater error strings to friendlier copy. Anything else
 *  falls through to a stable generic message. */
function formatInstallError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();

  // Known electron-updater failures, in order of likelihood:
  if (/no update filepath provided/i.test(stripped)) {
    return 'No update file staged — please try again later.';
  }
  if (/install lock|already running/i.test(stripped)) {
    return 'Another update install is already in progress.';
  }
  if (/quit sequence/i.test(stripped)) {
    // Our own 1.5s timeout from main/updater.ts.
    return 'The update did not start installing — please try again.';
  }

  // Fallback: show the stripped message if we have one, otherwise a
  // stable generic. The console.warn above always logs the full err
  // for support / debugging.
  return stripped || 'Could not install the update.';
}

export function UpdateBanner(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateDownloadedInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe once on mount. The unsubscribe matters in dev's
    // hot-reload path — without it, every HMR pass would attach a new
    // listener and the same `update-downloaded` event would fire N
    // times into stale React trees.
    const off = window.optix.updater.onDownloaded((next) => {
      setInfo(next);
      setDismissed(false); // re-show if a NEWER update lands later
      setError(null); // clear any stale error from a previous attempt
    });
    return off;
  }, []);

  if (!info || dismissed) return null;

  const onRestart = async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      await window.optix.updater.installNow();
      // The successful path never reaches here — the main process
      // calls quitAndInstall, the renderer terminates within ~200ms.
      // If we DO reach this line, treat it as a silent no-op success
      // (e.g. user dev-tested without a staged update); leave the
      // banner up so they can try again.
      setInstalling(false);
    } catch (err) {
      // The IPC promise rejects when electron-updater can't actually
      // install (no staged file in dev, corrupted package in prod,
      // perms issue, etc). Re-enable the button + show a one-line
      // error so the user knows the click did something but didn't
      // succeed — much better UX than "Restarting…" forever.
      console.warn('[optix-update-banner] installNow failed:', err);
      setError(formatInstallError(err));
      setInstalling(false);
    }
  };

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v6" />
          <path d="m9 5 3-3 3 3" />
          <rect x="3" y="10" width="18" height="12" rx="2" />
          <path d="M8 16h8" />
        </svg>
      </div>
      <div className="update-banner__text">
        {error ? (
          <span className="update-banner__error">{error}</span>
        ) : (
          <>
            <strong>Update ready</strong>
            <span className="update-banner__version">v{info.version}</span>
          </>
        )}
      </div>
      <button
        type="button"
        className="update-banner__primary"
        onClick={onRestart}
        disabled={installing}
      >
        {installing ? 'Restarting…' : error ? 'Retry' : 'Restart now'}
      </button>
      <button
        type="button"
        className="update-banner__dismiss"
        onClick={() => setDismissed(true)}
        disabled={installing}
        aria-label="Dismiss update notification"
      >
        Later
      </button>
    </div>
  );
}
