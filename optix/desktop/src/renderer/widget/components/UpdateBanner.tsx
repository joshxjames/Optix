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

export function UpdateBanner(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateDownloadedInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // Subscribe once on mount. The unsubscribe matters in dev's
    // hot-reload path — without it, every HMR pass would attach a new
    // listener and the same `update-downloaded` event would fire N
    // times into stale React trees.
    const off = window.optix.updater.onDownloaded((next) => {
      setInfo(next);
      setDismissed(false); // re-show if a NEWER update lands later
    });
    return off;
  }, []);

  if (!info || dismissed) return null;

  const onRestart = async (): Promise<void> => {
    setInstalling(true);
    try {
      await window.optix.updater.installNow();
      // We won't actually reach here — the app exits within ~200ms.
    } catch (err) {
      // Defensive: if the install fails (very rare — usually a perms
      // issue or the staged file went missing) re-enable the button so
      // the user can retry instead of being stuck on "Restarting…".
      console.warn('[optix-update-banner] installNow failed:', err);
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
        <strong>Update ready</strong>
        <span className="update-banner__version">v{info.version}</span>
      </div>
      <button
        type="button"
        className="update-banner__primary"
        onClick={onRestart}
        disabled={installing}
      >
        {installing ? 'Restarting…' : 'Restart now'}
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
