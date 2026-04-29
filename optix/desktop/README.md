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

Abstracted behind `src/main/providers/base.ts`. Phase 1 implementations:

- Anthropic (`@anthropic-ai/sdk`)
- OpenAI (`openai`)
- Moonshot / Kimi (OpenAI-compatible, reuses the `openai` SDK with a custom base URL)
- Google Gemini (`@google/generative-ai`)

API keys are stored in the OS keychain via `keytar`.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window.
- Preload exposes a whitelisted API surface only.
- IPC payloads validated with Zod on the main-process side.
- Screen capture is explicit-trigger only (no background streaming).
- Privacy toggle in the widget disables capture entirely.

## Phase 1 scope

- Floating widget with prompt, capture, privacy, stop
- Settings window (API key + model selection per provider)
- "Explain" mode: capture screen → vision call → structured response
- In-memory session history

Phase 2 will add region capture, target-region highlighting, a custom-cursor overlay, TTS, and push-to-talk. Phase 3: mouse automation with approval gates.
