# @optix/desktop

Electron app — floating widget that can see your screen and answer questions about it.

## Dev

```bash
pnpm install              # from repo root
pnpm dev                  # launches Electron with HMR
```

## Build

```bash
pnpm build                # typecheck + bundle to out/
pnpm package:win          # → dist/Optix-0.1.0.exe (portable)
pnpm package:mac          # → dist/Optix-0.1.0.dmg
```

## Architecture

Three processes, isolated:

- **Main** (`src/main/`) — Node privileges. Window creation, IPC handlers, screen capture, provider calls, keychain access.
- **Preload** (`src/preload/`) — contextBridge shim. Exposes a narrow, typed `window.optix` API to renderers. No direct IPC access from renderer.
- **Renderer** (`src/renderer/`) — React UI. Two entry points: `widget/` (always-on-top floating widget) and `settings/` (config window).

Shared schemas (Zod) live in `src/shared/` and are imported by both main and renderer for identical validation on both sides.

## Providers

Abstracted behind `src/main/providers/base.ts` (Ask) and `src/main/automation/agent-providers/types.ts` (Access). Currently shipped:

- Anthropic (`@anthropic-ai/sdk`)
- OpenAI (`openai`)
- Moonshot / Kimi (OpenAI-compatible, reuses the `openai` SDK with a custom base URL)
- Google Gemini (`@google/generative-ai`)
- **Optix Cloud** — relay-routed Anthropic, no API key required (see below)

API keys for the BYO-key providers are stored in the OS keychain via `keytar`.

## Optix Cloud integration

Optix Cloud is a fifth provider that piggybacks on the Anthropic adapter but routes every API call through our [optix-cloud](https://github.com/joshxjames/Optix-Cloud) Firebase relay instead of `api.anthropic.com`. The desktop client owns sign-in, checkout opening, and subscription management UI; the relay owns auth verification, subscription gating, usage metering, and Stripe webhooks.

Key files:

- **Ask provider** — `src/main/providers/optix-cloud.ts` reuses `runAnthropicPrompt` from the direct Anthropic adapter, just with a relay-bound SDK client (Bearer token instead of `x-api-key`).
- **Access agent** — `src/main/automation/agent-providers/optix-cloud.ts` extends the Anthropic agent adapter, swapping the SDK client at `init()` and exposing `refreshCredential()` so long-running conversations don't 401 when the Firebase ID token expires.
- **Magic-link sign-in** — `src/main/auth/loopback-server.ts` binds a one-shot 127.0.0.1 HTTP listener; `src/main/ipc/auth.ipc.ts` orchestrates. Renderer-side Firebase SDK runs in `src/renderer/widget/firebase.ts`.
- **Stripe checkout + management** — `src/main/ipc/stripe.ipc.ts` opens Checkout in the user's default browser via `shell.openExternal`, reuses the loopback server for the post-payment redirect, and proxies switch/cancel/reactivate calls to the relay's `updateSubscription` Cloud Function.
- **Settings UI** — `src/renderer/widget/components/SettingsPanel.tsx` (`OptixCloudSection`, `ActivePlanView`, `PricingCard`) renders sign-in / pricing / plan-management views; subscription state comes via a Firestore `onSnapshot` listener so webhook-driven changes flip the UI without polling.

See the [Optix-Cloud](https://github.com/joshxjames/Optix-Cloud) repo for the relay, webhook handlers, and Firestore rules.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window.
- Preload exposes a whitelisted API surface only.
- IPC payloads validated with Zod on the main-process side.
- Screen capture is explicit-trigger only (no background streaming).
- Privacy toggle in the widget disables capture entirely.

## Current features

- Ask / Access / Automate modes (Q&A, Computer Use agent, recording + replay)
- Plan tool with explicit approve / deny / feedback gate
- Recording captures UIA-anchored actions; replay via `/OA-N` slash menu
- Approval modes: per-task, per-action, never (out-of-workspace always gates)
- Workspace folder + cost ceiling (USD) for agent runs
- Screen-region overlay highlights for walkthrough answers
- Audit logs (every Access run), chat history (Ask conversations), routines list
- In-widget docs, light / dark theme, configurable global hotkey
- Optix Cloud subscription provider — managed Claude access, no API key
