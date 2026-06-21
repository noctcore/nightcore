# scripts/ — dogfood probes

Throwaway-but-tracked harnesses for manually validating Nightcore end-to-end.
Not part of the test suites (they hit a live server / real Claude); run them by
hand during dogfooding.

## `dogfood:ui` — `dogfood-ui.mjs`

Drives a Playwright **Chromium** against the **mock-mode web** and screenshots
every surface (board, projects kebab menu + ConfirmDialog, settings Limits knobs,
new-task sheet), reporting any console errors.

The live Tauri window is **WKWebView (macOS) and exposes no Chrome DevTools
Protocol**, so Playwright can't attach to the real app. Pointed at Vite (`:5173`)
the app runs in `!isTauri` mock mode (IPC no-ops) — this validates rendering and
interaction, not the live engine.

```bash
bun run web              # terminal 1 — serves :5173
bun run dogfood:ui       # terminal 2
# overrides: BASE_URL=http://localhost:5173 OUT_DIR=/tmp/nc bun run dogfood:ui
```

Screenshots land in `OUT_DIR` (default `/tmp/nightcore-dogfood`).

## `dogfood:engine` — `headless-harness.ts`

Drives the **real sidecar** (`apps/sidecar`) over its NDJSON stdio protocol —
exactly as the Rust core does — against a scratch git repo. Uses **real Claude**
(subscription auth via `~/.claude`). Validates the live SDK path: a build session
under `bypassPermissions` with native tools, the `maxTurns` guardrail firing, and
session **resume** via a captured `sdkSessionId`.

```bash
bun run dogfood:engine                       # defaults to a sibling ../test-repo
bun run dogfood:engine /path/to/scratch-repo # explicit scratch repo
# HARNESS_MODEL=claude-opus-4-8 bun run dogfood:engine
```

The scratch repo **is mutated** (a file is written, then cleaned up). Point it at
something safe — never a repo with work you care about.
