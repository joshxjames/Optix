// Auto-updater wiring. Polls a Firebase-Hosting-served `latest.yml` /
// `latest-mac.yml` feed every few hours, downloads new versions in the
// background, and broadcasts "ready to install" events to the widget
// renderer so it can show a non-intrusive banner.
//
// Hosting model: a Firebase Hosting "site" we'll set up under the
// existing `optix-22473` project (separate from the marketing site to
// keep the asset paths + cache headers independent). The user uploads
// the build artifacts via `firebase deploy --only hosting:updates`
// after each release. See `docs/AUTOUPDATE.md` for the full release
// checklist + cert procurement notes.
//
// What this file deliberately doesn't do:
//   - Surface "checking for updates" UI. The check is silent; we only
//     bother the user when there's something to install.
//   - Force-restart. The user picks the moment via the banner. If they
//     dismiss without restarting, electron-updater will install the
//     staged update on the next regular app quit (autoInstallOnAppQuit).
//   - Verify signatures explicitly. electron-updater enforces signature
//     checks automatically when the app + the new version are signed
//     with the same publisher cert. Until certs are wired up (Phase E),
//     dev builds will skip this check; production won't ship without it.

import { app } from 'electron';
// `electron-updater` is published as CommonJS-only and exposes its
// surface via module.exports. Under our ESM build (package.json
// `"type": "module"`), Node refuses to honour named imports against
// a CJS package — hence the SyntaxError "Named export 'autoUpdater'
// not found". Workaround per electron-updater's own docs: import the
// default and destructure. The package's CJS exports object IS the
// default in the ESM lens.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { IPC } from '@shared/ipc';
import type { UpdateDownloadedInfo } from '@shared/api';
import { getWidgetWindow } from '@main/windows/widget-window';

// TODO (Phase E): point this at the real Firebase Hosting "updates"
// site URL once it's provisioned. For now this is a placeholder so
// the wiring + dev-mode testing work; production builds without a
// real URL will silently fail every update check (the renderer never
// sees a banner, no harm done).
const UPDATE_FEED_URL = 'https://optix-22473.web.app/updates/';

// First check delay after app ready — gives main-process startup a
// chance to settle (window create, IPC handlers, screen pre-warm)
// before competing for network. 30s is short enough that updates land
// promptly for users who leave the app open all day.
const INITIAL_CHECK_DELAY_MS = 30_000;

// Repeat check cadence. Optix users often keep the app running for
// days at a time; checking once per business-day quarter is plenty.
const REPEAT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let initialised = false;

/** Wire the auto-updater. Idempotent — safe to call multiple times,
 *  but should only be called from main-process app-ready. */
export function initAutoUpdater(): void {
  if (initialised) return;
  initialised = true;

  // Dev-mode short-circuit. electron-updater normally refuses to run
  // in dev because there's no signed installer to update from; setting
  // this flag forces it to load `dev-app-update.yml` instead. The dev
  // file ships with a placeholder URL so devs can point at a local
  // server when they want to exercise the update flow.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  // Override the published feed URL (electron-builder writes the URL
  // into the bundled `app-update.yml` at build time, but until we wire
  // `publish:` in electron-builder.yml, the bundled file may be missing
  // or stale. Setting the feed URL programmatically belt-and-braces it).
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED_URL,
    // `useMultipleRangeRequest: false` — Firebase Hosting's CDN doesn't
    // play nicely with multipart range requests in some configurations.
    // Falling back to single-range keeps the diff downloader happy.
    useMultipleRangeRequest: false,
  });

  // We control the cadence — no auto-loop on the library's side.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.logger = {
    info: (msg) => console.info('[optix-updater]', msg),
    warn: (msg) => console.warn('[optix-updater]', msg),
    error: (msg) => console.error('[optix-updater]', msg),
    debug: () => {}, // too chatty, intentionally dropped
  };

  autoUpdater.on('checking-for-update', () => {
    console.info('[optix-updater] checking for update');
  });

  autoUpdater.on('update-available', (info) => {
    console.info(`[optix-updater] update available: v${info.version}`);
    // No banner yet — we wait for download to complete. Otherwise users
    // would see "Update available" then nothing for a minute while it
    // downloads, and might quit thinking it's broken.
  });

  autoUpdater.on('update-not-available', () => {
    console.info('[optix-updater] no update');
  });

  autoUpdater.on('download-progress', (progress) => {
    const win = getWidgetWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.updater.progress, {
      percent: Math.round(progress.percent ?? 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.info(`[optix-updater] downloaded v${info.version}, ready to install`);
    const win = getWidgetWindow();
    if (!win || win.isDestroyed()) return;
    const payload: UpdateDownloadedInfo = {
      version: info.version,
      // electron-updater types these as `string | ReleaseNoteInfo[]`.
      // Coerce to plain string for the simple banner we ship — full
      // release-note rendering can be added later if useful.
      releaseNotes:
        typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate,
    };
    win.webContents.send(IPC.updater.downloaded, payload);
  });

  autoUpdater.on('error', (err) => {
    // Don't surface to the renderer — failed update checks shouldn't
    // bother users mid-task. Log and try again on the next interval.
    console.warn('[optix-updater] error:', err?.message ?? err);
  });

  // Kick off the first check after the initial delay, then every few
  // hours. checkForUpdates() resolves the no-update case quickly so the
  // overhead is negligible.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[optix-updater] initial check failed:', err);
    });
  }, INITIAL_CHECK_DELAY_MS);

  setInterval(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[optix-updater] periodic check failed:', err);
    });
  }, REPEAT_CHECK_INTERVAL_MS);

  // Test hook: when `OPTIX_UPDATER_FAKE_DOWNLOADED=1` is set in the
  // environment, fire a synthetic `update-downloaded` event 5s after
  // init. Lets us exercise the renderer banner end-to-end without
  // needing a real signed installer or a live update feed. No-op in
  // production builds (the env var won't be set).
  if (process.env.OPTIX_UPDATER_FAKE_DOWNLOADED === '1') {
    console.info(
      '[optix-updater] FAKE mode enabled — synthetic update-downloaded in 5s',
    );
    setTimeout(() => {
      const win = getWidgetWindow();
      if (!win || win.isDestroyed()) {
        console.warn('[optix-updater] FAKE: widget window not available');
        return;
      }
      const fakeInfo: UpdateDownloadedInfo = {
        version: '99.0.0',
        releaseNotes: 'Synthetic banner — OPTIX_UPDATER_FAKE_DOWNLOADED=1',
      };
      console.info('[optix-updater] FAKE: dispatching update-downloaded', fakeInfo);
      win.webContents.send(IPC.updater.downloaded, fakeInfo);
    }, 5000);
  }
}

/** Trigger the "quit, install, relaunch" flow. Called from the
 *  updater IPC handler when the renderer's banner button fires.
 *
 *  Returns a Promise so the IPC layer can propagate failure back to
 *  the renderer banner. Without this, the renderer sits on
 *  "Restarting…" forever when:
 *    - The staged update file is missing or corrupted (production)
 *    - electron-updater can't acquire the install lock
 *    - The fake-event path tries to install with nothing staged
 *      (dev — see OPTIX_UPDATER_FAKE_DOWNLOADED in initAutoUpdater)
 *
 *  Resolution path: never. If the install succeeds, the app process
 *  is gone within ~200ms and the awaited promise is GC'd along with
 *  the renderer. The 1.5s timeout is the safety release for the
 *  banner button — if we're still alive then, something went wrong.
 */
export function quitAndInstallUpdate(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      autoUpdater.removeListener('error', onError);
      clearTimeout(timer);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          'Update install did not start the quit sequence — no staged update?',
        ),
      );
    }, 1500);

    autoUpdater.once('error', onError);

    try {
      // First arg `isSilent: false` shows the OS install UI (NSIS on
      // Windows ticks through quickly; macOS unzips silently anyway).
      // Second arg `isForceRunAfter: true` ensures Optix relaunches
      // after install — without it the user would have to manually
      // re-launch the app.
      autoUpdater.quitAndInstall(false, true);
      // Don't resolve here — successful path means the process is
      // about to exit. The promise gets GC'd along with the runtime.
    } catch (err) {
      // Synchronous throws are rare from electron-updater (it prefers
      // the `error` event), but possible. Cover the case so the
      // renderer always gets a definitive answer within 1.5s.
      onError(err instanceof Error ? err : new Error(String(err)));
    }
    // `resolve` is intentionally unused — see comment above.
    void resolve;
  });
}

