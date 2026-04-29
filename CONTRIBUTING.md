# Contributing to Optix

Thanks for your interest in helping out. Optix is open source and PRs are
welcome — bug fixes, new features, docs improvements, all of it.

This file is the practical guide. The high-level architecture lives in
[README.md](README.md); read that first if you haven't.

---

## Before you start

1. **Open an issue first for non-trivial changes.** A 2-line clarification
   is enough — it just saves you writing code we'd push back on. Bug fixes
   and obvious improvements can skip this step.
2. **Search existing issues + discussions** so you don't duplicate work.
3. **Be aware of the trust model.** Optix runs with screen capture, mouse +
   keyboard control, file system access, and a shell tool. Any feature that
   widens that surface area needs a clear safety story. See the [Security
   notes](README.md#security-notes) section in the README.

---

## Setting up

```bash
git clone https://github.com/joshxjames/Optix.git
cd Optix
pnpm install
pnpm dev
```

Prerequisites are listed in the [main README](README.md#prerequisites) —
Node 22+, pnpm 9+, a C++ toolchain + Python 3 for the native modules
(`robotjs`, `keytar`).

The `pnpm dev` loop has hot-reload for renderer changes. Main-process or
preload changes need a full restart (`Ctrl+C` and `pnpm dev` again).

`pnpm typecheck` runs strict TypeScript across all packages — please run it
before opening a PR. There's no test suite yet (good first contribution
area).

---

## Filing a bug

Use the **Bug report** template if one is configured, otherwise include:

- What you were doing (the prompt, the mode, the provider).
- What you expected to happen.
- What actually happened. Screenshots help a lot for UI bugs.
- The Optix version (`git log -1 --format=%h` from your clone), provider,
  model, OS, and Node version.
- Any relevant console output (DevTools is `F12` in the widget).

Don't include API keys or anything from `~/.../@optix/desktop/` user data.

---

## Submitting a pull request

1. **Fork** the repo and create a branch off `main`. Branch names like
   `fix/plan-icon-misalignment` or `feat/linux-packaging` are fine.
2. **Keep PRs focused.** One bug or one feature per PR. Smaller PRs land
   faster and review better.
3. **Run `pnpm typecheck`** before pushing. Strict mode is on; type errors
   block merge.
4. **Update docs and the in-app docs viewer** if your change affects user
   behaviour. The articles are in
   `optix/desktop/src/renderer/widget/components/docs/articles.ts`.
5. **Open the PR against `main`.** Link the related issue (`Closes #123`)
   in the description.
6. **Use a descriptive title.** PR titles often become squash-merge commit
   messages. "Fix bug" is not descriptive; "Fix plan banner clipping when
   sidebar is closed" is.

---

## Coding conventions

### TypeScript

- Strict mode is on across the project. Don't reach for `any`. Reach for
  `unknown` + a type guard, or `as any` with a one-line comment explaining
  why if you absolutely have to.
- Prefer `type` over `interface` unless you specifically need declaration
  merging.
- Imports are sorted: external packages first, then `@shared/*`,
  `@main/*`, then relative imports.

### IPC and the trust boundary

- The renderer is sandboxed. Any new capability the renderer needs goes
  through the preload bridge (`src/preload/index.ts`) as a whitelisted
  channel. Don't expose `ipcRenderer` directly.
- Every `ipcMain.handle()` payload is **Zod-validated** before any
  side-effectful code runs. No exceptions — TypeScript types are erased
  at runtime and don't protect the main process from a misbehaving
  renderer.
- Filesystem operations resolve symlinks via `realpath` before scope
  checks. See the existing patterns in
  `src/main/automation/file-executor.ts` and `src/main/storage/chat-history.ts`.
- External URLs (from the agent or a web-search response) go through
  `safeOpenExternal` in `src/main/security/safe-url.ts`. `http(s)` only.

### Renderer rendering

- **Never `dangerouslySetInnerHTML`.** All agent / model / file content
  renders as text nodes. The renderer's invariant is "no agent string
  ever becomes executable HTML".
- Add new icons to `src/renderer/widget/components/Icons.tsx` (Lucide-style
  inline SVG, painted via `currentColor` so themes work).
- New schemas live in `src/shared/schemas.ts` so both sides import the same
  validation.

### Comments

- Code that does what its name says doesn't need a comment.
- Code that has a non-obvious **why** (a constraint, an invariant, a
  workaround for a specific bug) gets a comment that says **why**.
- No "added for issue #X" or "removed in v0.5" — that belongs in commit
  messages and PR descriptions, not in code that future-you will read.

---

## Authorship

Commits and PRs are credited collectively under
`Optix Contributors <contributors@optix.dev>`. You don't need to match
your local `user.name`/`user.email` to anything specific — the squash
merge does the work.

Where you want personal credit, the GitHub Co-authored-by trailer is the
right place:

```
Co-Authored-By: Your Name <your-real@email.com>
```

GitHub picks that up and shows your avatar on the merge commit.

---

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating, you agree to abide by its terms.

---

## License

Contributions are licensed under the project's MIT license. See
[LICENSE](LICENSE).
