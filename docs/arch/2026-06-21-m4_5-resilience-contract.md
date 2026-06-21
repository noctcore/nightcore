# M4.5 Contract — Resilience & Observability (P0)

**Date:** 2026-06-21 · **Status:** FROZEN (orchestrator-owned). Hardening before live dogfooding. Backend-only; serde-additive; breaks nothing. Grounded in `docs/research/2026-06-21-recovery-and-logging-audit.md` (read it first — it has the file:line evidence).

Scope = the two P0s + the logging-quality the user asked for (colored console, meaningful coverage). P1s (SDK resume, persist loop-arming, `get_loop_state`) are explicitly **deferred** — they become the first dogfood tasks once the app is crash-safe.

---

## A. Boot reconciliation — kill the zombie tasks (Rust core)

A task left `InProgress`/`Verifying` when the process died is stranded forever (in-memory slots start empty; the auto-loop only re-picks `Backlog`/`Ready`; the sidecar that would emit its terminal event is dead). Fix at boot.

- New `reconcile_tasks(app)` in `coordinator.rs` (near `reconcile_worktrees`), **called in `lib.rs` setup right after `reconcile_worktrees`** (after the store is retargeted to the active project + `app.manage`'d).
- For every loaded task whose status is **`InProgress`**:
  - reset status → **`Ready`** (so the auto-loop re-picks it),
  - clear the stale `session_id` (the persisted id points at a dead session; `cancel_task`/`respond_permission` trust it — `sidecar.rs:693-697,735-738`),
  - clear the verification fields a fresh run would clear (`verified=false`, `review=None`, `fix_attempts=0`) — a reset task re-runs from scratch this milestone (RESUME is P1),
  - append a note to `task.error`: `"Interrupted by restart — requeued."`,
  - persist via `store.mutate` (emits `nc:task`).
- For every loaded task whose status is **`Verifying`**: the build worktree was retained, so **re-dispatch the reviewer over it** rather than redoing the build — reuse `dispatch_reviewer_for` (already `pub(crate)`). If re-dispatch isn't cleanly possible at setup time (sidecar not yet up), fall back to resetting it to `Ready` like the `InProgress` case (document which path you took). Either way it must leave `Verifying` and have a path forward.
- **`WaitingApproval`/`Done`/`Failed`/`Backlog`/`Ready` are left untouched** — they're terminal or already launchable; the plan text / review text is persisted so the user's approval actions still work.
- **Breaker pause survives restart? → YES** is the locked decision, but persisting the breaker is P1 (`settings.rs`); for P0 just **log** at boot whether any reconciliation happened and how many tasks were requeued.
- Tests: a store seeded with `InProgress` + `Verifying` tasks → after `reconcile_tasks` (the pure inner fn, no AppHandle), `InProgress`→`Ready` with cleared session/verify fields + the note; assert `Done`/`Backlog` untouched. Mirror the existing `move_task_inner`-style testable-inner pattern.

---

## B. Persistent, colored, correlated logging (Rust core + provider + sidecar)

**Goal (user's words): colored console output, and log the stuff that actually tells us what's happening and what fails.** Two sinks from one framework: a **colored** human console (dev) and a **plain** rotating file (always, so a bundled app isn't dark).

### B1. Rust logging framework
- Adopt **`tracing` + `tracing-subscriber` + `tracing-appender`** (preferred over `tauri-plugin-log` for structured fields/correlation). Add to `apps/desktop/src-tauri/Cargo.toml`.
- Initialize **once** in `lib.rs` setup, before anything else runs:
  - a **console layer** with ANSI **colors on**, compact format, level + target + the message + fields;
  - a **file layer** (ANSI off) via `tracing-appender` daily-rolling to **Tauri's `app_log_dir()`** (resolve it like `app_config_dir()` at `lib.rs:40-44`); filename e.g. `nightcore.log`. Keep the guard alive for the app lifetime.
  - level from `RUST_LOG` env if set, else default `info` (a `logLevel` settings knob is P2).
- **Migrate all 14 `eprintln!` sites** (`store/project/sidecar/coordinator/settings/m2/worktree`) to the right level: real failures → `error!`/`warn!`, lifecycle → `info!`, detail → `debug!`. No bare `eprintln!` left for diagnostics (a deliberate user-facing `println!` is fine if any exists).

### B2. Correlation
Every log line about a task/session carries structured fields — use tracing fields, not string interpolation: `task_id`, and `session_id` where known. Prefer a per-run `info_span!("run", task_id=…)` entered around launch/terminal handling so nested logs inherit the id.

### B3. What to actually log (the coverage the user asked for) — at minimum:
- **Sidecar lifecycle:** spawn (`info` "sidecar starting", with entry/cwd), ready, unexpected stdout-close/exit (`warn`/`error`), protocol parse errors (`warn`, the bad line at `debug`).
- **Task lifecycle:** launch (`info` task_id, model, kind, worktree branch), status transitions (`info`), terminal success (`info` with cost), failure (`error` with the message), abort (`info`).
- **Verification gate:** entering `Verifying` (`info`), reviewer dispatched, verdict parsed (`info` PASS/CHANGES_REQUESTED/FAIL), auto-fix attempt N/max (`info`), parked-for-approval (`warn`).
- **Gauntlet:** each step start (`debug`/`info`), pass/fail with exit code (`info`/`error`), overall result.
- **Worktree:** allocate / cleanup / reconcile-prune (`info`/`debug`), failures (`warn`).
- **Coordinator/loop:** arm/stop/resume (`info`), breaker trip → pause (`warn`), tick-drained (`debug`).
- **Permissions:** relay a request (`info` task_id + tool name — **never the input args**, they may carry paths/commands/secrets), decision sent (`debug`).
- **Boot reconciliation (§A):** how many tasks requeued, and each requeue (`info`/`warn`).
- **Secrets discipline (hard rule):** never log tokens/secrets; never log permission tool **inputs**, diff bodies, or gauntlet output bodies at `info` — those may go to `debug` only, and never to telemetry. Tool *names* and step *names* are fine.

### B4. Capture the sidecar's stderr (stop inheriting it)
- The sidecar already emits good structured leveled lines (`packages/shared/src/logger.ts`) but `provider.rs:149` `Stdio::inherit()` throws them at the host terminal, uncaptured. Change to **`Stdio::piped()`** and spawn a **stderr drain task** (sibling to the stdout reader at `sidecar.rs:66-82`) that reads each line and re-emits it through the Rust `tracing` sink tagged `target: "sidecar"` (so it lands in the same colored console + the same file). Pick a sensible level (sidecar lines are already `LEVEL`-prefixed; either parse the level or log them all at `info`/`debug` under the `sidecar` target — parsing the prefix to map the level is nicer if cheap).

### B5. Color the sidecar's own console logger too
- `packages/shared/src/logger.ts` currently writes plain text. Add **level-based ANSI colors** when stderr is a TTY (`process.stderr.isTTY`) — e.g. error=red, warn=yellow, info=cyan/green, debug=dim/gray — and fall back to **no color when not a TTY** (so the Rust-captured/file form stays clean and parseable). Keep the existing `<ISO> <LEVEL> [<scope>] <msg> <json>` shape; only the LEVEL token (or the whole line) gets colorized. Update its existing tests so the no-TTY path asserts plain output.

---

## C. Guardrails
- Serde-additive only; no `Task` shape change beyond what reconciliation writes to existing fields. Existing tests stay green (106 cargo / 165 web / 39 plugin / 213 node).
- Console stays colored & readable in `tauri dev`; the file sink is the safety net for bundled runs — verify a log file actually appears under the OS app-log dir.
- stdout of the sidecar child remains the **pure NDJSON protocol** — logging changes touch **stderr only**, never stdout (don't corrupt the protocol).
- No secret/token/permission-input/diff-body ever reaches `info` or the file at a level that ships; `debug` only, never telemetry.
- P1 deferred: SDK session resume, persisted loop-arming + breaker pause, `get_loop_state` snapshot, `logLevel` settings knob, in-UI "view logs" — these are the first dogfood tasks.
