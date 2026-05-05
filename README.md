# Optix

An open-source AI co-pilot that lives in a floating desktop widget. It can answer
questions about what's on your screen, take actions on your machine when you
let it, and record those actions as reusable automations.

Bring your own provider API key — or skip the API-key part entirely with
**Optix Cloud**, our optional managed plan. Either way everything runs
locally; nothing leaves your machine except the prompts and screenshots you
send to the model.

---

## What it does

Optix has three modes you switch between with a tab:

- **Ask** — single-shot Q&A. Optix takes a screenshot of your active window,
  sends it to the model with your question, and streams the answer back.
  No actions, no file access. The safest place to start.
- **Access** — full agent loop. The model can click, type, scroll, drag, run
  shell commands, list/read/write files, search the web, and ask you
  clarifying questions. Per-action approvals or a single per-task gate keep
  you in control.
- **Automate** — Access plus recording. Run a task once with the Record toggle
  on and it gets saved as a routine you can replay later by typing `/OA-N` in
  any prompt. Recordings capture semantic anchors (UIA element names, window
  titles), not just pixel coordinates, so they survive layout shifts.

Other notable bits:

- **Plan tool** — for complex multi-step tasks the model writes a plan first;
  you Approve, Deny, or send Feedback. Approved plans persist across runs so
  the model stays on track.
- **Workspace folder** — pick a directory and the agent can work inside it
  freely; anything outside always asks for explicit approval, regardless of
  approval mode.
- **Cost ceiling** — set a USD cap per Access run; Optix stops the loop if
  estimated spend crosses it. (Cost is tracked for Anthropic / Optix Cloud
  models only — when you bring your own OpenAI / Kimi / Gemini key, those
  providers handle billing directly and Optix doesn't intermediate.)
- **Audit log** — every Access run is saved as inspectable JSON (messages,
  turns, actions, per-turn token usage, and exact cost for Anthropic /
  Optix Cloud runs). Same for Ask conversations and saved automations.
- **Privacy pause** — toggle off screen capture for sensitive work; the
  agent runs blind without crashing.

---

## Quickstart

```bash
# 1. Clone
git clone https://github.com/joshxjames/Optix.git
cd Optix

# 2. Install (pnpm only — the lockfile is pnpm-shaped)
pnpm install

# 3. Run
pnpm dev
```

That last command launches Electron with hot-reload. The widget appears at
the bottom-right of your primary display. Click the gear icon to add an API
key for at least one provider (Anthropic, OpenAI, Kimi, or Google), then
type a prompt in Ask mode.

---

## Prerequisites

You need a working build chain because two of the dependencies
(`robotjs` for input simulation and `keytar` for the OS keychain) are
native modules. Once installed they cache; subsequent installs are fast.

- **Node.js 22 or newer** — `node --version`. Use [nvm](https://github.com/coreybutler/nvm-windows)
  / [fnm](https://github.com/Schniz/fnm) / [Volta](https://volta.sh/) if you
  juggle versions.
- **pnpm 9+** — `npm install -g pnpm`. Don't substitute npm/yarn; the
  lockfile is pnpm-specific.
- **A C++ toolchain + Python 3** (for the native rebuilds):
  - **Windows** — install [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
    with the "Desktop development with C++" workload, plus
    [Python 3.x](https://www.python.org/downloads/).
  - **macOS** — `xcode-select --install`.
  - **Linux** — `sudo apt install build-essential python3` (or your distro's
    equivalent).
- **A provider API key** — at least one of:
  - [Anthropic](https://console.anthropic.com/) (recommended for agent loops;
    most accurate visual click)
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Moonshot / Kimi](https://platform.moonshot.ai/)
  - [Google AI Studio](https://aistudio.google.com/app/apikey) (Gemini)

Keys are stored in your OS keychain via `keytar` — never on disk in plaintext.

---

## What permissions Optix uses

Because the agent can take real actions on your machine, the app uses some
sensitive system surfaces. Worth knowing what they are:

- **Screen capture** — to take screenshots and send them to the model.
  The widget hides itself from its own captures (Windows DWM affinity / macOS
  NSWindowSharingNone) so it doesn't appear in the analysis frame.
- **Mouse + keyboard control** — robotjs drives clicks, typing, scrolling,
  drag, and key presses. Only fires when the agent emits an action.
- **File system** — read/write inside the workspace folder you set; anything
  outside always asks for explicit approval.
- **Shell** — `run_command` runs non-interactive shell commands (npm install,
  pytest, git, etc.) with a 60-second default timeout, capped at 120 seconds.
  Output is captured and truncated to 16 KB tail.
- **Network** — outgoing HTTPS calls to your chosen provider. DuckDuckGo
  HTML is used as a web-search fallback for providers without native search.

Approval modes give you per-task or per-action gates if you want a tighter
leash. The "never" mode skips prompts inside the workspace but still gates
anything outside it.

---

## Optix Cloud (optional)

Don't want to manage an API key? Pick **Optix Cloud** as your provider in
Settings. Sign in with email — a one-time link arrives in your inbox, you
click it, the widget unlocks. Then choose a plan:

- **Starter — $49/mo** — 5M tokens/month, Claude Opus 4.7, all three modes,
  web search included.
- **Pro — $99/mo** — 15M tokens/month, everything in Starter, priority
  support.

Plans are billed monthly via Stripe and cancellable anytime. Upgrading or
downgrading happens immediately (Stripe prorates the difference); cancelling
keeps your access until the end of the current paid period, then auto-stops.

The cloud relay forwards every request body to Anthropic byte-for-byte and
**never logs request or response content** — only the token totals it needs
for billing. Your prompts, screenshots, and Claude's replies stay between
you and Anthropic; we just sit in the network path with our admin API key
attached. The relay's source is in the
[Optix-Cloud](https://github.com/joshxjames/Optix-Cloud) repo if you want
to verify.

The two paths coexist: every BYO-key provider (Anthropic / OpenAI / Kimi /
Gemini) still works exactly the same. Switch back via the Settings provider
picker any time.

---

## Hotkey

By default `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) toggles the widget
in and out of view. Customise the binding in Settings → Hotkey. Conflicts
with existing OS shortcuts cause silent registration failure — pick something
less common if it doesn't work.

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

Three Electron processes, isolated by Chromium's standard sandboxing:

- **Main** has Node privileges. Holds the IPC handlers, drives screen
  capture, talks to the model providers, runs robotjs / shell / file
  operations, and persists the audit log + chat history + routines + plans.
- **Preload** is a tiny contextBridge shim. The renderer can only call
  the channels we whitelist on `window.optix`; raw `ipcRenderer` is not
  exposed.
- **Renderer** is a sandboxed React app (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`).

All IPC payloads are validated by Zod schemas on the main side before they
reach any side-effectful code. Filesystem operations resolve symlinks via
`realpath` before scope checks. External URLs from the agent or web search
are filtered to http(s) only before the OS handler ever sees them.

### Provider model

Every provider implementation lives behind a small interface in
`optix/desktop/src/main/providers/base.ts` and
`optix/desktop/src/main/automation/agent-providers/types.ts`.
Adding a new provider means writing one adapter; the rest of the app doesn't
need to know.

Currently shipped (model IDs are the exact strings the SDKs accept; the
Settings picker mirrors `optix/desktop/src/shared/models.ts`):

- Anthropic — `claude-opus-4-7`, `claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`
- OpenAI — `gpt-4o-2024-11-20`, `gpt-4o-mini-2024-07-18` (via the Responses
  API)
- Moonshot / Kimi — `kimi-k2.5`, `kimi-latest`,
  `moonshot-v1-8k-vision-preview` (OpenAI-compatible; reuses the `openai`
  SDK with a custom base URL)
- Google Gemini — `gemini-1.5-pro`, `gemini-1.5-flash`,
  `gemini-2.0-flash-exp`

Settings also accepts a custom model ID per provider if you want one not in
the picker.

---

## Storage

Everything Optix saves lives under your OS user-data directory:

- `audit/loops/` — one JSON per Access run
- `conversations/<id>/` — saved Ask conversations + their attachment images
- `routines/<id>.json` — recorded automations
- `plans/current.json` — the single global active plan

API keys are **not** in any of those — they're in your OS keychain via
`keytar`. Settings (provider, model, approval mode, hotkey, etc.) are in
the standard electron-store config file in the same user-data dir.

---

## Security notes

Optix is open source partly so the trust model can be audited. A few
relevant invariants the codebase tries to preserve:

- The agent never runs arbitrary URLs through the OS handler. `openUrl`,
  the window-open handler, and DuckDuckGo URL extraction all go through a
  central allowlist that drops anything that isn't `http(s)`.
- File writes resolve symlinks via `realpath` before the scope check —
  a planted symlink can't redirect a workspace-scoped write to a sensitive
  system location.
- The renderer is sandboxed and can only call the IPC channels listed in
  the preload bridge. All payloads are Zod-validated on the main side.
- Out-of-workspace file ops and shell commands always gate, regardless of
  the user-set approval mode — that's the hard boundary.
- The widget hides itself from its own screen captures so the model doesn't
  end up analysing Optix's own UI.

These aren't claims of perfect security — they're the design intent. If you
spot a gap, please open an issue or PR.

---

## Roadmap

- [x] Three modes: Ask, Access, Automate
- [x] Plan tool with approve / deny / feedback
- [x] Routine recording with semantic anchors (UIA element name, window title)
- [x] `/OA-N` token references for invoking saved routines from any prompt
- [x] Per-action and per-task approvals + workspace boundary
- [x] Audit log with export to Markdown / text / JSON
- [x] In-app documentation viewer
- [ ] Packaged installers (NSIS for Windows, signed DMG for macOS) — currently
      dev-server-only
- [ ] Linux packaging
- [ ] Routine parameters (`{{name}}` templating)
- [ ] Self-test mode for verifying everything works after install

---

## Support

- **Bugs and feature requests** — open an issue on
  [GitHub Issues](https://github.com/joshxjames/Optix/issues).
- **Questions, ideas, and longer-form discussion** — head to
  [GitHub Discussions](https://github.com/joshxjames/Optix/discussions).
- **Security disclosures** — please open a private security advisory via
  [GitHub Security](https://github.com/joshxjames/Optix/security/advisories/new)
  rather than filing a public issue.

There's no email channel for support. Everything goes through the repo so
the answers stay searchable for the next person with the same question.

---

## Contributing

PRs welcome. The `pnpm dev` loop has hot-reload for renderer changes;
main-process changes need a restart. `pnpm typecheck` runs strict TypeScript
across all packages. There's no test suite yet — that's a contribution area.

If you're adding a feature:

- New IPC channels go through the preload bridge with Zod validation on the
  main side. Don't expose raw `ipcRenderer`.
- New schemas live in `src/shared/`; both sides import from there.
- The renderer's trust model is "no agent string ever becomes HTML" — render
  agent output as text nodes only. No `dangerouslySetInnerHTML`.

Commits and PRs are credited under the repo's collective authorship
(`Optix Contributors`) rather than individuals, so don't worry about
matching your local git config to anything specific.

---

## License

MIT. See [LICENSE](LICENSE). Copyright held by the Optix Contributors.
