# Debug Report: Auto mode crashes the release app (SIGABRT) — `tokio::spawn` in a sync Tauri command

**Date:** 2026-06-27
**Agent:** kirei-debug
**Status:** root cause confirmed

## Symptom
Starting "auto mode" in the packaged release build (`bun run desktop:build` → `/Applications/Nightcore.app`) hard-crashes the whole process. macOS shows the native "Application unexpectedly quit" dialog (Polish: "Aplikacja Nightcore nieoczekiwanie zakończyła pracę", Reopen / Ignore / Report). This is a native process abort, not a webview JS error.

macOS crash report `~/Library/Logs/DiagnosticReports/nightcore-2026-06-27-161645.ips`:
- `exception: { type: EXC_CRASH, signal: SIGABRT }`, `termination: Abort trap: 6`, `asi: libsystem_c.dylib ["abort() called"]`
- Faulting thread 0 = `com.apple.main-thread`. Backtrace (innermost first):
```
abort
std::process::abort
__rustc::rust_panic
std::panicking::panic_with_hook
core::panicking::panic_fmt
tokio::task::spawn::spawn                                   +192   <- panics here
nightcore_lib::m2::coordinator::start                       +408
nightcore_lib::run::{{closure}}::{{closure}}                       <- sync Tauri command body
tauri::webview::Webview::on_message
tauri::ipc::protocol::get::{{closure}}
wry::wkwebview::class::url_scheme_handler::start_task              <- extern "C" WKWebView callback
WebKit::WebURLSchemeHandlerCocoa::platformStartTask ... (Obj-C / IPC)
```

App log `~/Library/Logs/dev.shirone.nightcore/nightcore.log.2026-06-27`, last line before the crash (timestamps are UTC; crash captureTime is +0200):
```
2026-06-27T14:16:41.576093Z  INFO nightcore: auto-loop armed max_concurrency=3
```
`14:16:41 UTC` = `16:16:41 +0200` = the crash `captureTime` 2026-06-27 16:16:41.5987. The next log line (`14:16:46 logging initialized`) is the app restarting after the user clicked Reopen.

## Expected
Arming the auto-loop spawns the background tick task and returns; the app stays alive and starts pulling eligible tasks.

## Repro
**Command / scenario:**
```
1. Build + install the release app:  bun run desktop:build  (→ /Applications/Nightcore.app)
2. Launch it, open a project, click "start auto mode" (invokes the start_auto_loop IPC command).
3. The process aborts immediately (SIGABRT) → native crash dialog.
```
Single-task runs ("Run" on one task) do NOT crash — see Root Cause for why.

**Standalone mechanism repro** (pinned to the same tokio 1.52.3), proving the panic and the fix:
```rust
fn main() {
    let _ = tokio::spawn(async {});   // no runtime entered on this thread
}
// -> thread 'main' panicked: "there is no reactor running, must be called
//    from the context of a Tokio 1.x runtime"  (exit 101)
```
Reverse-test (same non-runtime thread): `stored_handle.spawn(async {})` — the exact mechanism of `tauri::async_runtime::spawn` — does NOT panic.

**Reliability:** Deterministic — every invocation of `start_auto_loop` (and `stop_auto_loop` / `resume_auto_loop`) aborts the process, in any build (debug or release). It only surfaced now because auto mode is a less-traveled path; the user's earlier single-task runs use a different, runtime-safe command.

## Root Cause
**Location:** `apps/desktop/src-tauri/src/m2/coordinator.rs:250` (and the identical defect at `:269`)
**Mechanism:** `start_auto_loop` is a **synchronous** `#[tauri::command] pub fn` (coordinator.rs:734-737), so Tauri runs it directly on the main thread inside the WKWebView IPC handler — a thread with **no Tokio runtime entered** — and the bare `tokio::spawn(...)` inside `start()` panics with *"there is no reactor running, must be called from the context of a Tokio 1.x runtime"*; that panic unwinds across wry's `extern "C"` `url_scheme_handler::start_task` boundary, which converts the unwind into `abort()` → SIGABRT → the native crash dialog.
**Introduced by:** commit `1763414c` (2026-06-21) — the `tokio::spawn` calls in `start()`/`stop()` have been present since the coordinator was added.

### Why release crashed but single-task runs (and "dev") seemed fine — exact on/off conditions
- `run_task` (single-task launch, `apps/desktop/src-tauri/src/sidecar/commands.rs:27`) is `pub **async** fn` → Tauri drives it on `tauri::async_runtime` (inside the Tokio runtime), so any `tokio::spawn` it reaches is in-context and valid. The app log shows sessions 13–20 (13:45–14:16) all completing normally via this path.
- `start_auto_loop` / `stop_auto_loop` / `resume_auto_loop` (coordinator.rs:735 / 741 / 748) are `pub **fn**` (sync) → main thread, no runtime → their `tokio::spawn` panics.
- `set_max_concurrency_cmd` / `list_worktrees` are also sync but call no `tokio::spawn`, so they never crash.

This predicts exactly what the log shows: many successful single-task sessions, then a crash on the very first `auto-loop armed`. The crash mechanism is build-independent (not a `panic=abort` profile difference — the repo sets no `[profile.release] panic`); the abort comes from the panic crossing the Objective-C/`extern "C"` FFI boundary, which happens in any build. "dev does not crash" is incidental: auto mode simply wasn't exercised on a current dev build.

## Evidence
- Crash backtrace ends in `tokio::task::spawn::spawn → core::panicking::panic_fmt`, called from `nightcore_lib::m2::coordinator::start`, on `com.apple.main-thread`, dispatched by the Tauri sync-command IPC path. (verbatim above)
- App log: `auto-loop armed max_concurrency=3` is the last line, timestamp-matched to the crash to the same second.
- tokio source: `tokio-1.52.3/src/util/error.rs:5` `CONTEXT_MISSING_ERROR = "there is no reactor running, must be called from the context of a Tokio 1.x runtime"`, panicked at `tokio-1.52.3/src/task/spawn.rs:212` (`Err(e) => panic!("{}", e)`).
- tauri source: `tauri-2.11.2/src/async_runtime.rs` keeps a `static RUNTIME: OnceLock<GlobalRuntime>` and `spawn` does `self.handle.spawn(task)` on a stored `tokio::runtime::Handle` — works from any thread, no entered context required.
- Standalone repro (tokio 1.52.3): bare `tokio::spawn` off-runtime → panic "there is no reactor running…"; reverse-test `stored_handle.spawn` off-runtime → ok. Confirms both the cause and the fix.

## Recommended Fix
**Approach:** Replace the two bare `tokio::spawn(...)` calls in the sync `start()`/`stop()` with `tauri::async_runtime::spawn(...)`, which spawns onto Tauri's global runtime handle and is valid from any thread (sync command, async command, or internal caller). Minimal, local, and robust against every call site.

**Files to change:**
- `apps/desktop/src-tauri/src/m2/coordinator.rs:250` — `tokio::spawn(async move { run_loop(app, generation).await; })` → `tauri::async_runtime::spawn(async move { run_loop(app, generation).await; })`
- `apps/desktop/src-tauri/src/m2/coordinator.rs:269` — `tokio::spawn(async move { app.state::<Orchestrator>().interrupt_all().await; })` → `tauri::async_runtime::spawn(async move { ... })`

Notes for the implementer:
- Keep `start()`/`stop()`/`resume()`/`start_auto_loop`/`stop_auto_loop`/`resume_auto_loop` synchronous — `tauri::async_runtime::spawn` removes the need to make them async. (Converting only the commands to `async fn` would fix the entry points but leaves `start()`/`stop()` panic-prone if ever called from another sync context, e.g. `resume()` → `start()`.)
- `JoinHandle` types differ (`tauri::async_runtime::JoinHandle` vs `tokio::task::JoinHandle`); both calls discard the handle, so no signature changes are needed.
- Audit the other 6 `tokio::spawn` sites (`provider.rs:388`, `slots.rs:256`, `coordinator.rs:497`, plus tests) — those run inside already-async contexts (within `run_loop`/async fns) and are fine; no change required, but worth a sweep for any future sync caller.

## Regression Test to Promote
The repro should become a permanent test that arms the loop from a **non-async (main-thread-equivalent) context** and asserts no panic. Use Tauri's mock app so an `AppHandle` is available.

- **Test file:** `apps/desktop/src-tauri/src/m2/coordinator.rs` (under `#[cfg(test)] mod tests`)
- **Prereq:** enable Tauri's `test` feature for dev (`tauri = { version = "2.11.2", features = ["test"] }` in `[dev-dependencies]` or a `test` feature), giving `tauri::test::mock_builder()` / `MockRuntime`.
- **Test body (intent — adapt to the Orchestrator constructor):**
```rust
#[test] // NOTE: a plain #[test], NOT #[tokio::test], to reproduce the no-runtime main-thread context
fn arming_auto_loop_does_not_panic_off_runtime() {
    use tauri::test::{mock_builder, mock_context, noop_assets};
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app");
    app.manage(Orchestrator::new_for_test()); // construct/inject a test Orchestrator
    // Must NOT panic — pre-fix this aborts with "there is no reactor running…".
    super::start(&app.handle()).expect("arming the auto-loop must not panic off-runtime");
    super::stop(&app.handle()); // also exercises the :269 spawn
}
```
If wiring a full mock `Orchestrator` is too heavy, a cheaper guard that still fails pre-fix: assert that the spawn helper used by `start`/`stop` is `tauri::async_runtime::spawn` (e.g. a small `fn arm_spawn` indirection covered by a `#[test]` that calls it off-runtime and expects `Ok`).

## Instrumentation to Remove
None — diagnosed from the existing macOS crash report, the app log, source/dependency reading, and a throwaway standalone repro under the session scratchpad (`/private/tmp/.../scratchpad/spawn-repro`, outside the repo). No instrumentation was added to project source; nothing to clean up in the tree.

## Risks
- `tauri::async_runtime::spawn` requires the global runtime to be initialized — it is, since Tauri sets it up before any command can be dispatched; safe at every `start`/`stop` call site.
- Behavioral parity: the spawned futures are unchanged; only the spawner changes. No change to scheduling semantics that the loop relies on (`run_loop` already uses `app.state`, `Notify`, generation checks).
- Do not "fix" by adding `#[tokio::main]` to `main.rs` or wrapping the command body in `block_on` — that would block the main thread / nest runtimes.

## How to Verify the Fix
1. Apply the fix (swap both `tokio::spawn` → `tauri::async_runtime::spawn` at coordinator.rs:250 and :269).
2. No instrumentation to remove.
3. Add + run the regression test — must pass (pre-fix it aborts).
4. `bun run --filter @nightcore/sidecar compile` then `bun run desktop:build`; launch the release app, click "start auto mode" → loop arms, `nc:loop` goes `running`, no crash; click stop → `drained`, no crash.
5. Confirm no new `nightcore-*.ips` crash report is generated and the app log shows `auto-loop armed` followed by tick activity rather than a restart.
