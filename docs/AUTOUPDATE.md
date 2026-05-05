# Auto-update — release checklist

Optix ships fresh versions to installed copies via [electron-updater](https://www.electron.build/auto-update). The feed lives on **Firebase Hosting** (under the existing `optix-22473` project, on a dedicated "updates" site). The desktop app polls that feed every 4 hours, downloads new versions in the background, and surfaces a non-intrusive banner in the widget when an install is ready.

This doc covers the things that AREN'T already wired up in code — the **one-time setup** (certs, Firebase site provisioning) and the **per-release ritual** (build, sign, deploy).

---

## What's already done in code

- `optix/desktop/src/main/updater.ts` — wires `electron-updater`, polls every 4h, broadcasts events to the widget.
- `optix/desktop/src/main/ipc/updater.ipc.ts` — the `updater:installNow` IPC handler.
- `optix/desktop/src/preload/index.ts` — `optix.updater.{onDownloaded, onProgress, installNow}` bridge.
- `optix/desktop/src/renderer/widget/components/UpdateBanner.tsx` — the in-widget "Update ready / Restart now / Later" banner.
- `optix/desktop/electron-builder.yml` — Windows target switched to `nsis` (mandatory for auto-update); `publish: { provider: generic, url: ... }` baked in.
- `optix/desktop/dev-app-update.yml` — dev-mode config so the updater works under `pnpm dev`.

The placeholder URL is **`https://optix-22473.web.app/updates/`**. Update this in three places when you've finalised the real URL: `electron-builder.yml`, `main/updater.ts`, and `dev-app-update.yml`.

---

## One-time setup

### 1. Code signing certificates

Without signing, every Windows update triggers SmartScreen warnings ("Windows protected your PC") and macOS Gatekeeper blocks the install outright. Required.

#### Windows — Authenticode certificate

- **Standard cert**: ~$200/yr from DigiCert / Sectigo / GlobalSign. Cheaper but accumulates SmartScreen reputation slowly (first ~3 weeks of installs trigger warnings).
- **EV cert (recommended)**: ~$300+/yr, plus a hardware token (USB key shipped to you). Instant SmartScreen reputation from the first install.

After receiving the cert:
- Save the `.pfx` file somewhere safe outside the repo
- Decide where it lives in CI: secret file in GitHub Actions, or stored on a build machine
- Set CI env vars `WINDOWS_CERT_FILE` (path) + `WINDOWS_CERT_PASSWORD`
- Uncomment the `signtoolOptions:` block in `electron-builder.yml` (the TODO comments under `win:` show the exact shape)

#### macOS — Apple Developer Program

- $99/yr at [developer.apple.com](https://developer.apple.com).
- Generate a "Developer ID Application" certificate from the developer portal — this is the one electron-builder uses for distribution outside the Mac App Store.
- Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com) for notarization.

CI env vars:
- `APPLE_ID` — your Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD` — the password you just generated
- `APPLE_TEAM_ID` — 10-character ID from developer.apple.com → Membership

Then in `electron-builder.yml` under `mac:`:
- Replace `identity: null` with the cert's Common Name (e.g. `"Developer ID Application: Covetable Pty Ltd (TEAMID)"`)
- Replace `notarize: false` with `notarize: { teamId: ${env.APPLE_TEAM_ID} }`

### 2. Firebase Hosting "updates" site

The marketing site lives at `optix-22473.web.app` (or your custom domain). The update feed needs a separate path so the cache headers + path conventions don't collide. Use Firebase's [multi-site hosting](https://firebase.google.com/docs/hosting/multisites).

```bash
# From optix-cloud/ (where firebase.json lives)
firebase hosting:sites:create optix-22473-updates
firebase target:apply hosting updates optix-22473-updates
```

Add a second site config to `optix-cloud/firebase.json`:

```jsonc
{
  "hosting": [
    {
      "target": "main",
      "public": "../website/dist",
      // ... existing config ...
    },
    {
      "target": "updates",
      "public": "../optix/desktop/dist",
      "headers": [
        {
          "source": "**/*.@(yml|yaml)",
          "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }]
        },
        {
          "source": "**/*.@(exe|dmg|zip|nupkg|blockmap)",
          "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
        }
      ]
    }
  ]
}
```

Why these headers:
- `latest.yml` / `latest-mac.yml` are the manifest files the updater polls. Short cache (5min) so a fresh release reaches users quickly without thundering-herd hits on Firebase.
- Binaries (`.exe`, `.dmg`, `.nupkg`, `.blockmap`) are content-addressed by version in their filenames, so they're safe to cache forever.

The deployed feed will live at `https://optix-22473-updates.web.app/`. Update the three URL placeholders in code once you've confirmed it's reachable.

### 3. Bandwidth math

A signed Windows installer is ~80–120 MB. Firebase Hosting Blaze: $0.15/GB egress.
- 1,000 active installs × 100 MB / month = 100 GB = **$15/month**
- 10,000 active installs × 100 MB / month = 1 TB = **$150/month**

If this becomes a real cost, two paths:
1. Move just the binaries (not the manifest) to **Cloudflare R2** — free egress. Manifest stays on Firebase Hosting; the manifest's `path:` field can point at a different host.
2. Use **delta updates** (electron-updater's blockmap mechanism) — typical delta is 5–10% of full installer size. Already enabled by default in electron-builder for NSIS.

Path 1 is cheap and one-shot. Path 2 happens automatically. The `assetsInlineLimit` etc. don't apply — these are full installers.

---

## Per-release ritual

```bash
# 1. Bump version
cd optix/desktop
npm version patch   # or minor / major

# 2. Build + sign + emit manifest
pnpm package:win    # → dist/Optix-X.Y.Z.exe + dist/latest.yml + dist/Optix-X.Y.Z.exe.blockmap
# OR
pnpm package:mac    # → dist/Optix-X.Y.Z.dmg + dist/latest-mac.yml + dist/Optix-X.Y.Z.dmg.blockmap

# 3. Sanity-check the manifest
cat dist/latest.yml
# version: X.Y.Z
# files:
#   - url: Optix-X.Y.Z.exe
#     sha512: <hash>
#     size: <bytes>
# path: Optix-X.Y.Z.exe
# sha512: <hash>
# releaseDate: ...

# 4. Deploy to Firebase Hosting "updates" site
cd ../../optix-cloud   # or wherever firebase.json lives
firebase deploy --only hosting:updates

# 5. Verify it's reachable
curl https://optix-22473-updates.web.app/latest.yml
```

Existing installs running an older version will see the new manifest within their next 4-hour check window (typically minutes if the user just opened the app), download in the background, and show the in-widget banner.

### Rollback

If a release breaks, redeploy the previous version's `latest.yml` (with the older version's filename + sha512). Optix instances mid-download will discard the in-progress download once they re-check and see the version went backwards. Instances that already finished downloading won't auto-revert, but they'll pick up the next forward release that supersedes the broken one.

Keep the previous N releases' artifacts in the bucket — they're cheap and useful for both rollback and for users explicitly downloading from the website.

---

## Testing the flow locally

The fastest end-to-end loop without rebuilding everything:

```bash
# Terminal 1 — serve a fake "updates" directory
mkdir -p /tmp/optix-fake-updates
cd /tmp/optix-fake-updates
# Drop in a latest.yml that claims version "99.0.0" + a real installer
# (you can copy one from a previous release dist/)
npx serve -p 8000

# Terminal 2 — point dev-app-update.yml at localhost:8000
sed -i 's|optix-22473.web.app|localhost:8000|' optix/desktop/dev-app-update.yml

# Terminal 3 — run dev
cd optix/desktop && pnpm dev
# Within 30s, the update banner should appear in the widget
```

For the renderer-side banner without a real download, force the IPC event by hand:

```ts
// In main process, anywhere after window creation:
import { getWidgetWindow } from '@main/windows/widget-window';
import { IPC } from '@shared/ipc';
getWidgetWindow()?.webContents.send(IPC.updater.downloaded, {
  version: '99.0.0',
  releaseNotes: 'Test banner',
});
```

The banner should slide down from the top, "Restart now" should call `installNow` (which will fail in dev mode because there's nothing staged — that's fine for visual testing).
