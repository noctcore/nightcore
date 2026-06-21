# Recovery & Logging Audit — Nightcore

**Date:** 2026-06-21 · **Status:** RESEARCH ONLY (static read; no implementation). Verify the zombie repro live before building (`kill -9` the Tauri process mid-run, restart).

One line: **task *status* is durably persisted, but 100% of in-flight orchestrator state is in-memory and there is zero task reconciliation at boot — so a crash mid-run leaves permanent `InProgress`/`Verifying` zombies. And there is no persisted log anywhere: a bundled app goes dark on failure.**

---

## SECTION 1 — Crash / restart / HMR recovery

### Current state (what works)
- **Tasks persist synchronously on every transition.** `TaskStore` write-throughs to `<project>/.nightcore/tasks/<id>.json` on every `upsert`/`mutate` (`store.rs:124-146`, `:163-167`). `InProgress`/`Verifying` are written like any status. After a crash the on-disk record faithfully reflects the last status.
- **Web HMR is mostly fine.** Vite reloads only the webview; the Rust core + sidecar child survive. On mount the board re-hydrates via `list_tasks` + re-subscribes to `nc:task/session/loop/permission` (`AppShell.hooks.ts:268-271, 288-348`).

### Gaps
| # | Sev | Gap | Evidence |
|---|---|---|---|
| 1 | **Critical** | **Zombie `InProgress`/`Verifying` tasks.** No boot reconciliation resets/resumes them. Persisted as `in_progress`, but in-memory `SlotManager` starts empty and `eligible_tasks` only admits `Backlog`/`Ready` (`deps.rs:33-55`) → coordinator never re-picks it, no event ever arrives (sidecar is dead), task stranded forever (manual drag-out is the only escape). | `lib.rs:35-74` (only `reconcile_worktrees`, no task reconcile); `coordinator.rs:449-460` |
| 2 | High | **Session resume saved but never wired.** `sdkSessionId` is captured (`session-manager.ts:248`) and persisted to `<home>/sessions/index.jsonl` (`storage/src/index.ts`); the SDK supports `Options.resume` (`sdk.d.ts:1713-1715`) — but `session-runner.ts:122-143/225-251` never sets it. Recovery can only **RESET (re-run from scratch)**, never **RESUME**. Re-run also clears `verified/review/fix_attempts`. | `session-runner.ts`, `provider.rs:267-274` |
| 3 | Medium | **Auto-loop arming not persisted** → silent stop across restart. The `running` flag (`coordinator.rs:46-51`) resets to `false`; nothing re-arms. A running queue quietly halts until the user re-clicks Auto Mode. | `coordinator.rs:46-51` |
| 4 | Medium | **No `get_loop_state` snapshot command.** `nc:loop` is event-only (`coordinator.rs:184-195`); after HMR/fresh mount the Auto-Mode indicator shows stale/idle until the next transition. | grep: no `get_loop_state` |
| 5 | Low | **Breaker pause not persisted** — a known-broken-setup pause resets un-tripped on restart; the loop re-hammers it. | `breaker.rs:25-30` |
| 6 | Low | **Live stream scrollback not re-hydrated** on webview mount (durable transcript still lives in the SDK's `~/.claude/projects/`). | `AppShell.hooks.ts:303-313` |
| 7 | Low | **Stranded interactive permission requests** (parked `requestId` lost, no live session to drain). Mostly subsumed by fixing #1. | `coordinator.rs:64-65` |

**In-memory state lost on every restart:** SlotManager leases, PendingPermissions, session↔task correlation map, circuit-breaker counters, auto-loop arming flag — all constructed empty at `lib.rs:60-64`.

---

## SECTION 2 — Logging / observability

### Current state
- **Rust core = bare `eprintln!` to stderr.** No framework (`Cargo.toml` has no `tracing`/`log`/`tauri-plugin-log`), no levels, no file sink, no correlation. 14 sites across `store/project/sidecar/coordinator/settings/worktree`. Most lines lack a task/session id.
- **Sidecar = a real structured leveled logger** (`packages/shared/src/logger.ts`: ISO-ts + LEVEL + scope + json-meta; levels `silent..debug`), child-scoped per session. Driven by `config.logLevel` (default `info`, settable in `~/.nightcore/config.json`). **But its stderr is `Stdio::inherit()`'d** (`provider.rs:149`) → goes to the host terminal, never captured or persisted.

### Gaps
| # | Sev | Gap |
|---|---|---|
| 1 | **Critical for bundling** | **No persisted log file anywhere.** All diagnostics are ephemeral stderr. A packaged `.app`/`.exe` launched from Finder has no terminal → **both** Rust and sidecar logs vanish. Nothing is written to `app_log_dir()`. |
| 2 | High | Rust core has no logging framework (unconditional/unleveled/uncorrelated `eprintln!`). |
| 3 | High | Sidecar stderr is inherited, not captured → its good structured lines are neither merged nor persisted. |
| 4 | Medium | No correlation (task-id/session-id/level/timestamp) on Rust log lines. |
| 5 | Medium | No Rust-side `logLevel` knob, and the desktop never sets the sidecar's `logLevel` (two unrelated config systems). |
| 6 | Low | Failure diagnostics not surfaced in-UI beyond a one-line `task.error`. |

**Net:** the board shows *that* a task failed + a one-line `error`; the *why* (sidecar logs, SDK stderr, Rust diagnostics) is ephemeral and lost on restart.

---

## Prioritized build list (proposed milestone "M4.5 — Resilience & Observability")

**P0 — Recovery: boot reconciliation** *(Rust core)* — in `lib.rs` setup (after the store is retargeted, alongside `reconcile_worktrees`), add `reconcile_tasks`: every loaded task in `{InProgress, Verifying}` is recovered. MVP = reset to `Ready` + note in `task.error` ("interrupted by restart") + clear the stale `session_id`; persist via `store.mutate`. For `Verifying`, prefer re-dispatching the reviewer over the retained worktree (`dispatch_reviewer_for` is already `pub(crate)`) rather than redoing the build.

**P0 — Logging: persistent file sink + capture sidecar stderr** *(Rust core + provider)* — add `tauri-plugin-log` (or `tracing` + `tracing-appender`) writing to `app_log_dir()`; migrate the 14 `eprintln!` sites to leveled macros (keep stderr for `tauri dev`). Change `provider.rs:149` `Stdio::inherit()` → `Stdio::piped()` + a drain task that forwards each sidecar stderr line into the same sink tagged `scope=sidecar`.

**P1 — Recovery: wire SDK resume** *(contracts + engine + provider)* — optional resume id on `start-session` → thread into `query({ options: { resume } })`; source from persisted `sdkSessionId`. Lets P0 choose resume vs reset. (Validate `resume` mutual-exclusions in the pinned SDK `Options`.)

**P1 — Recovery: persist loop arming + breaker pause** *(Rust core, `settings.rs`)* — re-arm the loop in setup if it was on; decide whether a breaker pause should survive (lean yes).

**P1 — Recovery: `get_loop_state` command** *(Rust core + web)* — snapshot the `emit_state` payload; `useLoopState` fetches it on mount.

**P2 — Logging: Rust `logLevel` knob + correlation + sidecar level bridge** *(Rust + spawn path)*. **P2 — Web: re-hydrate stream tail + "view logs" on failed tasks.**

### Open product decisions
- Zombie policy: reset-and-rerun (simple, available now) vs resume (preserves work; re-entering mid-`Verifying` is ambiguous). Recommend reset `InProgress`→`Ready`; re-dispatch reviewer for `Verifying`.
- Should a breaker pause survive restart? (lean yes — don't auto-resume a known-broken setup.)
