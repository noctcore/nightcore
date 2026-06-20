# Spike — `bun build --compile` of the Nightcore CLI

**Date:** 2026-06-21
**Status:** Resolved — **compile succeeds, but the standalone binary is NOT
self-contained.** The SDK's 216 MB native `claude` CLI is resolved at runtime
from `node_modules`, not embedded. For distribution, set
`options.pathToClaudeCodeExecutable` (or ship the native binary alongside).
**Source ref:** `docs/architecture.md` → "Deferred spikes"; entry point
`apps/cli/src/index.ts`.

---

## 1. Exact command run

```bash
bun build --compile apps/cli/src/index.ts --outfile <tmp>/nightcore
```

(Run against a gitignored temp path; the produced binary was removed after the
spike — see §6.)

## 2. Result — the build itself

**Success.**

```
[31ms]  bundle  109 modules
[87ms] compile  <tmp>/nightcore
exit 0
```

- Produced binary size: **~65 MB** (`65,130,338` bytes) — this is Bun's own
  runtime + the 109 bundled JS modules (engine, contracts, config, shared, zod,
  the SDK's JS shim).
- `<binary> --help` works immediately — arg parsing and the JS graph are fully
  embedded and run with no `node_modules` present.

## 3. Result — does it actually drive a session?

This is the load-bearing question, and the answer is **conditional**:

### 3a. Run from an isolated dir (no `node_modules` nearby) — **FAILS**

Copied the binary to a fresh temp dir with a clean `HOME` and ran
`nightcore "say hi"`:

```
▶ session 1 (claude-opus-4-8)
WARN [cli:session-1] session runner crashed Error: Native CLI binary for
  darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without
  --omit=optional, or set options.pathToClaudeCodeExecutable.
✗ failed (runner-crash): Native CLI binary for darwin-arm64 not found. …
```

The session started, reached the SDK, and the SDK could not locate the native
`claude` executable. Note it **degraded gracefully** to a `session-failed`
event — the degrade-not-throw design holds even inside the compiled binary.

### 3b. Run from inside the repo (`node_modules` present) — **WORKS**

The same binary, run with `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
present, ran a full real session end-to-end:

```
▶ session 1 (claude-opus-4-8)
✓ ready — sdk session 13c7ec2b-…
Hi! 👋 How can I help you today?
■ done — 1 turn(s), $0.1184
```

## 4. Root cause — why the native binary isn't bundled

The Claude Agent SDK ships its CLI as **per-platform optional dependencies**
(`@anthropic-ai/claude-agent-sdk-darwin-arm64`, `-linux-x64`, `-win32-x64`, …).
Each contains a single **216 MB native `claude` binary**
(`215,952,608` bytes for darwin-arm64).

- `bun build --compile` bundles the **JS module graph** (109 modules, ~65 MB
  total with the Bun runtime). It does **not** trace and embed a sibling-package
  *native executable* that the SDK locates and `child_process.spawn`s at runtime.
- At runtime the SDK resolves that binary **relative to `node_modules`** (cwd /
  the SDK module location). Inside the repo it's found; in a distributed,
  `node_modules`-free location it is not — hence the split result in §3.
- Sanity check on sizes: a self-contained binary would have to be ≥ ~280 MB
  (65 MB JS+runtime + 216 MB native CLI). The 65 MB output alone proves the
  native binary was never embedded.

The runner already sets `executable: 'bun'` in its SDK `Options`
(`session-runner.ts:84`) — that controls the *JS host*, and is unrelated to the
native `claude` CLI resolution. The relevant escape hatch is a different option.

## 5. Recommendation

`bun build --compile` is **viable for distribution**, but the binary is **not
self-contained** out of the box. Two paths:

1. **Recommended — pin the executable explicitly.** Set
   `options.pathToClaudeCodeExecutable` (SDK `Options`, confirmed at
   `sdk.d.ts:1642`) in `SessionRunner.run()`'s options object to an absolute path
   the binary computes at startup. The user installs the Claude CLI (already a
   documented prerequisite — see the README/auth note), and Nightcore resolves
   *that* on `PATH` (e.g. `which claude` / a known install location) rather than
   relying on a bundled `node_modules`. This matches the existing "bring your own
   Claude CLI credentials" auth model: the CLI is already a host-level
   prerequisite, so depending on a host-level CLI binary is consistent.

2. **Alternative — ship the native binary alongside.** Distribute the compiled
   `nightcore` together with the correct per-platform `claude` binary and point
   `pathToClaudeCodeExecutable` at it. This makes the distribution self-contained
   but ~280 MB per platform and re-introduces per-platform packaging — heavier,
   and partly redundant with the user already having the Claude CLI.

Either way, **do not rely on the implicit `node_modules` resolution for a
shipped binary** — it only works from a dev checkout.

### Concrete follow-up (separate task; no engine source changed here)

- Add an optional `pathToClaudeCodeExecutable` resolution in the engine: compute
  it once (env override → `which claude` → known install paths) and thread it
  through `SessionRunnerConfig` into the SDK `Options`. Fall back to today's
  implicit behavior when unset (so dev checkouts keep working).
- Gate a `bun build --compile` step in CI behind that change, and smoke-test the
  produced binary from a `node_modules`-free dir (the §3a scenario) as the
  regression guard.

## 6. Cleanup

The compiled binary and both temp directories were deleted after the spike.
`dist/` and `node_modules/` are gitignored; the build was written only to
`/tmp`, so nothing was added to the tree or staged.
