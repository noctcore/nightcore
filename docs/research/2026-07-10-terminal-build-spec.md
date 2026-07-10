# Build spec: integrated worktree terminal (global tabbed view)

**Date:** 2026-07-10
**Ticket:** wayfinder #85 (research, closed) — this spec resolves its § 6 decision round
(grilled 2026-07-10). Every decision below is locked; do NOT re-litigate; implement.
**Architecture source (read first, authoritative for mechanics):**
`docs/research/2026-07-10-worktree-terminal-feasibility.md` — PTY crate (§ 2, `portable-pty`
0.9.0), transport (`tauri::ipc::Channel`, NOT events — load-bearing), WKWebView trap list,
xterm.js notes, existing-plumbing map, tier-by-tier architecture (§ 2), testing strategy (§ 4).
**Queue position:** build starts after the ENFORCE-coverage PR (Phase-1 PR 4) merges.

---

## 1. Decision record (grilled 2026-07-10)

| # | § 6 decision | Outcome |
|---|---|---|
| 1 | Security presentation | **Unconfined default + opt-in confined toggle ships in v1.** The terminal is a human seam (never agent-reachable). Default tabs are fully unconfined with identity chrome saying so. A per-tab "Confined" option (macOS-only) reuses the existing opt-in Seatbelt write-containment machinery, scoped to the session's cwd. Confinement-as-default was rejected. |
| 2 | Lifetime on worktree cleanup | **Cleanup blocks with a confirm.** Merge/discard with live sessions in the target dir surfaces "N terminal sessions open in this worktree" inside the EXISTING merge/discard dialogs; confirming kills those sessions, then cleanup proceeds. No silent kill. |
| 3 | Persistence scope | **Scrollback persists to disk.** Sessions survive UI navigation (they live in Rust). On app relaunch, dead sessions restore their scrollback READ-ONLY with a fresh shell underneath (Aperant-style). |
| 4 | UI home | **Global Terminal view with tabs** (AutoMaker-style) — a first-class nav destination, not a per-worktree panel. |
| 5 | Editor launch | **Already shipped** (PR #102): CLI-first allowlisted detection (`infra/editor.rs` `KNOWN_EDITORS` via PATH `which`, id persisted in Settings). No further work. |
| 6 | Session count | **N sessions, free tabs, capped at 8.** New-tab picker offers any worktree or the repo root; multiple tabs on one worktree are allowed. |
| 7 | Renderer | **DOM default, WebGL behind a GPU toggle** with `onContextLoss` auto-fallback to DOM. Default stays DOM while xtermjs#5816 (WebGL corruption, macOS 26.5 beta, repro'd from Tauri) is open; the Settings toggle opts in. |

**Locked defaults:** nav row in the `project` group, label **"Terminal"**, hint **`L`**
(`R` is reserved for the spec'd History view, `2026-07-10-phase2-history-rail-spec.md`);
confined toggle lives in the new-tab picker, default OFF, hidden on non-macOS; scrollback
ring ≈10k lines/session, serialized under `.nightcore/terminals/<sessionId>.json`, pruned on
worktree deletion and 30-day age; identity chrome visually distinguishes unconfined vs
confined tabs.

**Hard constraints:** the terminal seam is USER-ONLY — no command, event, or store path may
make a PTY reachable from an agent session (the PreToolUse confinement gate and the flight
recorder never see it, by design; keep it that way). `.nightcore/terminals/` is a NEW
directory — the frozen `{insights,scorecards,harness}` layouts are untouched. Scrollback may
contain secrets: the serialize path must be excluded from any future export/Trust-Report
surface by default.

---

## 2. PR slicing (staged like the PR-system builds; each independently green)

### PR A — Rust `terminal/` backbone

New top-level module `apps/desktop/src-tauri/src/terminal/` (peer of `provider/`,
`worktree.rs`, per the backend decomposition):

- Session registry: `SessionId → PtySession` (spawn via `portable-pty` with cwd + shell from
  `$SHELL` fallback `/bin/zsh`; cap **8** live sessions — spawn beyond cap is a
  user-visible error, not an eviction).
- Reader/coalescer thread per session (feasibility § 2 mechanics): PTY output → coalesced
  chunks → `ipc::Channel<Vec<u8>>` (binary, NOT JSON events).
- Scrollback ring (~10k lines) maintained Rust-side; serialized to
  `.nightcore/terminals/<sessionId>.json` on session exit AND periodically (crash-safe
  enough; exact cadence implementer's call) via the atomic-write idiom (`store/atomic.rs`).
- Lifecycle commands (in `commands/`, thin over the module): `terminal_spawn` (cwd,
  confined flag), `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_list`,
  `terminal_sessions_in_dir(path)` (the cleanup-confirm seam),
  `terminal_list_persisted` + `terminal_read_persisted` (for PR C restore),
  prune-on-worktree-delete + 30-day age pruning.
- Confined spawn (decision 1): when the flag is set (macOS only), wrap the shell launch in
  the existing Seatbelt write-containment profile machinery, write-scoped to the session
  cwd. Fail-closed: if profile assembly fails, refuse the confined spawn with an error —
  never silently fall back to unconfined.
- Async commands + `spawn_blocking` where syscalls block (the sync-command WKWebView freeze
  trap); registry behind the usual state pattern.
- Tests per feasibility § 4: registry unit tests + real-PTY round-trip (echo) + ring-buffer
  + serialization round-trip + cap enforcement. Real-PTY tests must be CI-safe (no TTY
  assumptions beyond `portable-pty`'s own).

### PR B — web Terminal view

- `AppView` union `+ 'terminal'` + render branch + nav row (`project` group, "Terminal",
  hint `L`) — union member and branch in the same commit (never orphan; `terminal` is not a
  REGISTRY view so `nav-render-parity` is unaffected, but the discipline holds).
- New `apps/web/src/components/terminal/TerminalView/` (folder-per-component, ≤400-line
  ratchet — tabs bar, tab content, and new-tab picker are separate components/folders).
- xterm.js, **DOM renderer** (PR B ships DOM-only; WebGL arrives in PR C behind the toggle);
  fit addon + resize observer → `terminal_resize`; binary Channel consumption per the
  feasibility WKWebView notes.
- Tabs: session list from `terminal_list`; new-tab picker = worktree list (reuse the
  Worktrees data source) + repo root; per-tab close = `terminal_kill` after confirm-if-alive.
- Identity chrome (decision 1): unconfined tabs carry the "your shell — unconfined" marker;
  confined tabs a distinct badge. Non-macOS: no confined option rendered.
- Merge/discard integration (decision 2): the existing worktree merge/discard dialogs call
  `terminal_sessions_in_dir`; if >0, render the blocking notice + "close sessions and
  continue" confirm which kills via `terminal_kill` then proceeds.
- Tests: hooks with an echo-bridge mock (feasibility § 4), tab lifecycle, picker, dialog
  gating; stories for populated/empty/confined states.

### PR C — persistence restore + toggles + polish

- Restore-on-relaunch (decision 3): on Terminal view mount, `terminal_list_persisted` →
  read-only tabs rendering persisted scrollback with a "session ended — start fresh shell
  here" action (spawns a new session with the same cwd if it still exists).
- WebGL toggle (decision 7): Settings GPU toggle (default OFF/DOM); when ON, load the WebGL
  addon with `onContextLoss` → dispose → DOM fallback + toast.
- Confined-toggle UX completion: new-tab picker checkbox (default off, sticky last-choice),
  Settings default, macOS gating.
- `dogfood:ui` extension (terminal renders, echo round-trip against the mock bridge),
  identity-chrome polish, docs.

## 3. Verification gates (per PR)

```
bun run lint && bun run lint:meta
bun run --filter @nightcore/web typecheck && bun run --filter @nightcore/web test
cargo fmt --all --check   # MUST run from apps/desktop/src-tauri — root has no Cargo.toml and silently no-ops
cargo test                # PR A adds real-PTY tests; ts-rs regen only if command return types are ts-rs-exported
bun run dogfood:ui        # PR B/C manual: tabs, echo, resize, cleanup-confirm, restore
```

PR A likely exports command return shapes (session descriptors) via ts-rs — commit the
regenerated `apps/web/src/lib/generated/` files; never hand-edit. No zod contracts are
expected (terminal traffic rides the binary Channel, not the event system); if an
implementer finds an event-system need, that is a spec deviation to flag, not silently add.

## 4. Estimate

Feasibility § 7's minimal v1 was 5–7 days; the grilled scope (global tabs, N sessions,
restart scrollback, WebGL toggle, confined toggle) puts this at **~8–10 focused days**
across the three staged PRs. Open-in-editor/Finder (0.5–1 d in the original table) already
shipped (#102) and is excluded.
