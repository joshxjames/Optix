# Optix

> **Proprietary.** Copyright (c) 2026 Covetable Pty Ltd. All rights reserved.
> See [LICENSE](LICENSE). Internal repository — do not redistribute.

Desktop AI assistant that lives in a floating widget. Three modes:

- **Ask** — single-shot Q&A over a screenshot of the active window.
- **Access** — full agent loop with mouse, keyboard, file system, shell, and
  web search. Per-action approvals or a per-task gate keep the user in the loop.
- **Automate** — Access plus recording. Run a task once with the Record toggle
  and it's saved as a routine, replayable by typing `/OA-N` in any prompt.
  Recordings capture semantic anchors (UIA element names, window titles) so
  they survive layout shifts.

Other notable bits:

- **Plan tool** — for complex multi-step tasks the model writes a plan first;
  the user Approves / Denies / sends Feedback. Approved plans persist across
  runs.
- **Workspace folder** — pick a directory and the agent can work inside it
  freely; anything outside always asks for explicit approval, regardless of
  approval mode.
- **Cost ceiling** — USD cap per Access run; loop stops if estimated spend
  crosses it. Cost tracking is for Anthropic / Optix Cloud only — BYO-key
  providers handle their own billing.
- **Audit log** — every Access run saves as inspectable JSON (messages, turns,
  actions, per-turn token usage, and exact cost where applicable).
- **Privacy pause** — toggle off screen capture for sensitive work; the agent
  runs blind without crashing.

---

## Quickstart

```bash
# 1. Clone (private repo — needs auth)
git clone git@github.com:joshxjames/Optix.git
cd Optix

# 2. Install (pnpm only — the lockfile is pnpm-shaped)
pnpm install

# 3. Run
pnpm dev
```

`pnpm dev` launches Electron with hot-reload. The widget appears at the
bottom-right of the primary display. Click the gear icon to add an API key
(Anthropic, OpenAI, Kimi, or Google) or sign in to Optix Cloud.

---

## Prerequisites

Two dependencies (`@hurdlegroup/robotjs` for input simulation and `keytar`
for the OS keychain) are native modules. They cache after first install.

- **Node.js 22 or newer** — `node --version`. Use nvm / fnm / Volta if
  juggling versions.
- **pnpm 9.12.0+** — `npm install -g pnpm@9.12.0`. Don't substitute npm/yarn;
  the lockfile is pnpm-specific.
- **A C++ toolchain + Python 3** for native rebuilds:
  - **Windows** — Visual Studio Build Tools 2022 with the "Desktop
    development with C++" workload, plus Python 3.x.
  - **macOS** — `xcode-select --install`.
  - **Linux** — `sudo apt install build-essential python3` or distro
    equivalent.
- **A provider API key**, at least one of:
  - [Anthropic](https://console.anthropic.com/) (recommended for agent loops;
    most accurate visual click).
  - [OpenAI](https://platform.openai.com/api-keys).
  - [Moonshot / Kimi](https://platform.moonshot.ai/).
  - [Google AI Studio](https://aistudio.google.com/app/apikey) (Gemini).

  Or use Optix Cloud (managed Anthropic via subscription).

Keys are stored in the OS keychain via `keytar` — never on disk in plaintext.

---

## What permissions Optix uses

The agent takes real actions on the machine, so it touches sensitive system
surfaces:

- **Screen capture** — screenshots fed to the model. The widget hides itself
  from its own captures (Windows DWM affinity / macOS NSWindowSharingNone).
- **Mouse + keyboard control** — robotjs drives clicks, typing, scrolling,
  drag, key presses. Only fires on agent-emitted actions.
- **File system** — read/write inside the workspace folder; out-of-scope ops
  always gate, regardless of approval mode.
- **Shell** — `run_command` runs non-interactive shell commands with a
  60-second default timeout, capped at 120 s. Output captured and truncated
  to a 16 KB tail.
- **Network** — outgoing HTTPS to the chosen provider. DuckDuckGo HTML is
  used as a web-search fallback for providers without native search.

---

## Optix Cloud

Optix Cloud is the managed subscription tier — sign in with email magic link,
pick a plan, the cloud relay forwards to Anthropic with our admin key
attached. The relay never logs request or response content; only token totals
for billing.

- **Starter — $49/mo** — 5M tokens/month, Claude Opus 4.7, all three modes,
  web search included.
- **Pro — $99/mo** — 15M tokens/month, everything in Starter, priority
  support.

Plans are billed monthly via Stripe and cancellable anytime. Upgrades /
downgrades happen immediately (Stripe prorates); cancellations keep access
until end of the paid period, then auto-stop.

The Cloud Functions backend lives in a separate `Optix-Cloud` repo.

---

## Hotkey

Default: `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) toggles widget
visibility. Customise in Settings → Hotkey. Conflicts with existing OS
shortcuts cause silent registration failure — pick something less common.

---

## Layout

```
optix/
└── desktop/                      # the Electron app
    ├── src/main/                 # Node-priv host: IPC, screen capture,
    │                             # provider calls, keychain, audit log
    ├── src/preload/              # contextBridge shim — narrow, typed
    │                             # `window.optix` API for renderers
    ├── src/renderer/widget/      # the floating widget React UI
    ├── src/renderer/overlay/     # transparent click-through overlay
    │                             # for on-screen highlights
    └── src/shared/               # Zod schemas + IPC channel constants
                                  # imported by both sides
website/                          # marketing site (independent)
```

---

## Architecture

Three Electron processes, isolated by Chromium's sandboxing:

- **Main** has Node privileges. Holds IPC handlers, drives screen capture,
  talks to providers, runs robotjs / shell / file ops, persists audit log +
  chat history + routines + plans.
- **Preload** is a contextBridge shim. The renderer can only call channels
  whitelisted on `window.optix`; raw `ipcRenderer` is not exposed.
- **Renderer** is a sandboxed React app (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`).

All IPC payloads are Zod-validated on the main side before reaching any
side-effectful code. Filesystem operations resolve symlinks via `realpath`
before scope checks. External URLs are filtered to http(s) only before the
OS handler ever sees them.

### Provider model

Every provider implementation lives behind a small interface in
`optix/desktop/src/main/providers/base.ts` and
`optix/desktop/src/main/automation/agent-providers/types.ts`.

Currently shipped (model IDs are the exact strings the SDKs accept; the
Settings picker mirrors `optix/desktop/src/shared/models.ts`):

- Anthropic — `claude-opus-4-7`, `claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`
- OpenAI — `gpt-4o-2024-11-20`, `gpt-4o-mini-2024-07-18` (Responses API)
- Moonshot / Kimi — `kimi-k2.5`, `kimi-latest`,
  `moonshot-v1-8k-vision-preview` (OpenAI-compatible; reuses the `openai`
  SDK with a custom base URL)
- Google Gemini — `gemini-1.5-pro`, `gemini-1.5-flash`,
  `gemini-2.0-flash-exp`

Settings accepts a custom model ID per provider for any model not in the
picker.

---

## Storage

Everything Optix saves lives under the OS user-data directory:

- `audit/loops/` — one JSON per Access run
- `conversations/<id>/` — saved Ask conversations + attachment images
- `routines/<id>.json` — recorded automations
- `plans/current.json` — single global active plan

API keys are **not** in those — they're in the OS keychain via `keytar`.
Settings (provider, model, approval mode, hotkey) live in the standard
electron-store config file in the same user-data dir.

---

## Security notes

Design invariants the codebase preserves:

- The agent never runs arbitrary URLs through the OS handler. `openUrl`,
  the window-open handler, and DuckDuckGo URL extraction all pass through
  a central allowlist that drops anything that isn't `http(s)`.
- File writes resolve symlinks via `realpath` before the scope check — a
  planted symlink can't redirect a workspace-scoped write to a sensitive
  system location.
- The renderer is sandboxed and can only call the IPC channels listed in
  the preload bridge. All payloads are Zod-validated on the main side.
- Out-of-workspace file ops and shell commands always gate, regardless of
  the user-set approval mode — that's the hard boundary.
- The widget hides itself from its own screen captures so the model doesn't
  analyse Optix's own UI.
- Per-action foreground HWND check (Round 9.1): destructive actions abort
  if the user Alt-Tab'd away mid-loop.
- API keys cached in-memory have a 5-minute TTL and zero on app quit.

---

## Support

In-app: open the **docs** button in the widget header → "Getting help"
article. The article includes a contact form that emails support directly.

For internal dev questions: see `.notes/` (gitignored).

---

## License

Proprietary. See [LICENSE](LICENSE). Copyright (c) 2026 Covetable Pty Ltd.
