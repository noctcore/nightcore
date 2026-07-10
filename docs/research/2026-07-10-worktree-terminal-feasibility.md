# Research: Integrated Worktree Terminal + Open-in-Editor/Finder — Feasibility

**Date:** 2026-07-10
**Ticket:** wayfinder #85 (roadmap item 7: "Integrated terminal + open-in-editor/Finder for worktrees")
**Status:** research complete — no code changed
**Companions:** `2026-07-05-worktree-capability-gap-automaker-vs-nightcore.md` (names this the
highest-ROI adjacent capability), `2026-07-10-competitive-landscape.md` (items 11–12: AutoMaker,
Aperant, Vibe Kanban all ship it; Nightcore has no answer).

## Question

How should Nightcore ship an integrated per-worktree terminal plus open-in-editor / reveal-in-Finder,
in a Tauri 2 app whose peers are all Electron — and how does a USER-driven terminal relate to the
agent confinement stack (PreToolUse workspace gate, deny/ask/allow tiers, opt-in Seatbelt sandbox)?

## TL;DR

- **Feasible and well-trodden.** All three reference apps converge on the same shape:
  PTY in the privileged process → coalesced output stream → xterm.js in the renderer.
  Nightcore's equivalent is `portable-pty` in the Rust core → Tauri `Channel` per terminal →
  `@xterm/xterm` in the WKWebView. No sidecar involvement.
- **Batching + flow control is the one real engineering problem.** Every reference implements
  (or intended to implement) output coalescing; naive per-chunk emits are the known failure
  mode — and Tauri's event system is *documented* as unsuitable for this (open memory-leak issue
  under sustained emits). The proven design: a 4–16 ms / 32–64 KB coalescing flush in Rust into
  a per-session binary `ipc::Channel`, a rAF write-buffer in the web tier (omniscribe's
  pattern), and xterm's official watermark flow control driving pause/resume of the Rust reader.
- **Security: the user terminal should be UNCONFINED (option a)** — same trust as Terminal.app —
  with an explicit visual identity separating it from agent activity, and a hard rule that no
  agent-reachable seam can write into the PTY. Confinement of the *user* is theater; the existing
  gates are all agent-session-scoped by construction and stay that way. Flagged below as a user
  decision only in its *presentation*, not its substance.
- **Open-in-editor/Finder is a half-day sibling**: two small Rust commands (`open -R` reveal;
  editor detection + launch), with paths resolved server-side from the task/project store, never
  accepted raw from the webview.
- **Effort: ~5–7 focused days** (Rust PTY module 2–2.5 d, web terminal 2–2.5 d, open-in-editor
  0.5–1 d, tests+dogfood already included in those numbers; detail below).

---

## 1. Reference implementations compared

Three local checkouts studied end-to-end (spawn → transport → xterm → lifecycle → tests).

| Axis | AutoMaker (Electron + Express daemon) | Aperant (Electron, ≤12 agent terminals) | omniscribe (Electron + NestJS; the user's own) |
|---|---|---|---|
| PTY library | `node-pty` 1.1.0-beta41, in the server process | `@lydell/node-pty` ^1.1.0 (maintained fork w/ prebuilds), in Electron main | `node-pty`, in a NestJS `TerminalService` in Electron main |
| Shell | Allowlist detection, `--login` for most shells | `SHELL \|\| /bin/zsh` + `-l` | `SHELL \|\| /bin/bash` + `-i` (deliberately interactive-not-login, like VS Code) |
| Env | Cleans app-specific vars; forces `TERM=xterm-256color`, `COLORTERM`; rc-file injection (BASH_ENV/ZDOTDIR) for custom prompt/theme | Strips `DEBUG`/`ANTHROPIC_API_KEY`/`CLAUDECODE`; injects TERM/COLORTERM | `buildSafeEnv` allow/blocklist (blocks `ELECTRON_*`, `NODE_OPTIONS`, `*_SECRET/TOKEN/PASSWORD/API_KEY` patterns); trusted ZDOTDIR for OSC 133 shell integration |
| Transport | Dedicated WebSocket per session (`/api/terminal/ws?sessionId=`), JSON frames | Plain Electron IPC `webContents.send` per PTY chunk — **no batching in the live path** | Socket.io gateway; service→gateway decoupled via in-process event emitter |
| Output batching | Server: 4 ms throttle, 4096-char flush cap | **None live** (a written-but-unwired `FlowController` was intended) | **Two-stage**: service coalesces at 32 ms/64 KB chunks (512 KB transient cap) + renderer rAF write-buffer (~60 writes/s); gateway char-based backpressure (256 KB high-water → `pty.pause()`, 15 s force-resume safety) |
| Scrollback/reattach | Server-side 50 000-char buffer replayed on WS reconnect (ordered: connected→scrollback→subscribe, race-proofed) | 100 KB main-process buffer + xterm SerializeAddon replay on remount; 30 s disk autosave for cross-restart restore | 500 KB service-side scrollback replayed on `terminal:join`; PTYs deliberately survive socket disconnect |
| xterm packages | `@xterm/xterm` 5.5 + fit/webgl/search/web-links; custom `file:line:col` link provider → open-in-editor | `@xterm/xterm` ^6.0 + fit/web-links/serialize/webgl; WebGL **off by default**, LRU context manager capped at 8 | `@xterm/xterm` ^6.0 + fit/search/web-links + **pooled WebGL** (6-context pool, steal-from-least-recently-visible-hidden, never steal visible, one context-loss recovery) |
| Resize | ResizeObserver → 100 ms debounce → fit → WS resize msg; 150 ms SIGWINCH output-suppression window | 200 ms debounce; sequence-numbered resize IPC + dimension-mismatch auto-correction; PTY spawn deferred until xterm reports real cols/rows | 100 ms debounce; exported pure `safeFit` (null/zero-dim guarded); hidden terminals skip resize |
| Sessions | Unlimited tabs/splits (cap 1000); PTYs survive UI reload; no idle reaping; SIGTERM→SIGKILL(1 s) | 12 per project; XState per-terminal machine; restore-from-disk on relaunch with 75 ms stagger; deferred `claude --continue` until tab activation | Session↔terminal map with ref-counted worktree cleanup; graceful SIGTERM poll → SIGKILL(3 s) |
| Security | Unconfined login shell; only auth on the WS + optional terminal password; `ALLOWED_ROOT_DIRECTORY` unset ⇒ allow-all | Unconfined by design (`sandbox:false`, no App Sandbox, entitlements explicitly allow child processes); YOLO `--dangerously-skip-permissions` is a feature | Unconfined shell; env sanitization is hygiene, not containment; gateway has per-socket session *ownership* (documented trust-model test) |
| Open-in-editor | `libs/platform/src/editor.ts`: 13-editor detection (CLI `which` first, then `/Applications` bundle → `open -a`), 5-min cache, file-manager fallback; server route validates absolute path | `worktreeOpenInIDE` IPC; fallback `shell.openPath(dir)`; **no** `showItemInFolder`/`open -R` | `vscode://`/`cursor://` protocol allowlist via `shell.openExternal`; editor validated against a fixed option list; **no** reveal-in-Finder either |
| Terminal tests | Vitest unit on `TerminalService` (node-pty fully mocked, fake timers for throttle/kill); **no WS-layer tests** | jsdom hook tests w/ hand-mocked xterm; node tests w/ mocked `@lydell/node-pty`; Playwright `_electron` e2e for copy/paste against the real PTY | **Five-layer battery** — see §4; the richest of the three |

### Lessons each contributes

**AutoMaker** — the *feature checklist*: per-worktree cwd, scrollback replay ordering
(connected → scrollback → subscribe, or you double-render), resize-window output suppression,
`file:line:col` link provider → editor, editor detection order (Cursor, VS Code, Zed, …
CLI-first then app-bundle), external-terminal launch as a separate affordance. Also a warning:
its docs drifted from code (4 ms vs "60fps"), and it reaps nothing (no idle timeout, cap 1000).

**Aperant** — the *scale + robustness* lessons: `@lydell/node-pty` is the maintained fork;
shutdown races between PTY callbacks and a destroyed window cause native SIGABRTs (guard flag);
unchanged-dimension resize needs a forced SIGWINCH cycle to make TUIs (Claude Code) redraw;
input writes must be chunked/serialized (a 9 KB paste once crashed 8-terminal sessions);
WebGL off-by-default with an LRU context cap. And the meta-lesson: **its most sophisticated
controllers (flow control, buffer persistence, PTY daemon) shipped as dead code** — zero
importers. Ambition ≠ wiring; keep v1 small and actually wired.

**omniscribe** (the user's own, and the preferred build/test reference) — the *architecture +
testing* blueprint:
- **Decouple service from transport**: `TerminalService` never touches sockets; it emits
  in-process events the gateway rebroadcasts. Nightcore analog: the Rust `terminal` module owns
  PTYs and exposes a subscription seam; the Tauri command/channel layer is a thin adapter.
  This is exactly the seam that makes the service unit-testable without a webview.
- **Three-stage output handling**: PTY coalesce (32 ms / 64 KB) → transport backpressure
  (char-counted high-water, pause the *kernel* via `pty.pause()`, force-resume safety timer) →
  renderer rAF write-buffer with a hidden-terminal 1 MB cap trimmed at newline boundaries.
- **OSC-based agent detection** (`osc-agent-detector.ts`): status from OSC 133/777 marks only,
  never output heuristics. Not needed for Nightcore v1 (agents don't run in user terminals) but
  the pattern is noted for any future "run Claude in a terminal" feature.
- **Testing philosophy** (§4 below): cut seams at PTY and transport; never instantiate real
  xterm in unit tests; control time everywhere; encode known trust-model gaps as asserted tests
  with TODO pointers instead of pretending they're closed.

---

## 2. The Tauri 2 path

Web research summary (claims primary-sourced and registry-verified 2026-07-10).

### Ecosystem: what exists, what doesn't

- **There is no official Tauri terminal story.** The official shell plugin has zero PTY support,
  `tauri-apps/plugins-workspace` has no PTY issues/PRs, and awesome-tauri lists no terminal
  plugin. Everyone hand-rolls the same stack.
- **`Tnze/tauri-plugin-pty` 0.3.1** (+ npm `tauri-pty`, a node-pty-shaped `IPty` API) is the only
  maintained drop-in (published 2026-07-08, portable-pty 0.9 underneath). **Evaluated and
  rejected for Nightcore**: its data path is an *invoke long-poll* (a hung
  `invoke("plugin:pty|read")` + one blocked tokio worker per idle terminal) rather than channel
  push; `pause`/`resume` and all flow-control options are `TODO`-stubbed; it carries a
  RUSTSEC-flagged dep (`safemem`, issue #1); and Nightcore needs registry-level lifecycle hooks
  (kill-on-worktree-discard, scrollback ring, store-resolved cwd) a plugin doesn't expose. Keep
  it as API-shape reference only.
- **Reference apps worth cribbing** (all active mid-2026):
  - `nashaofu/shell360` (1.1k stars, Tauri 2.11 — same as Nightcore) — the Channel-wiring
    reference: the open command receives a `tauri::ipc::Channel<PtyIpcEvent>`; the reader thread
    streams into that per-session channel; React + @xterm/xterm frontend.
  - `crynta/terax-ai` — the thread-discipline reference: openpty → spawn → `drop(slave)` →
    `clone_killer()` drop-guard; blocking reader (16 KiB reads) → capped pending buffer (4 MiB,
    **whole-buffer discard + inject `ESC c` on overflow, never a partial cut** — a partial cut
    slices a CSI sequence mid-stream and corrupts xterm's parser state); coalescing flusher
    (4 ms after first byte) → binary Channel; separate `child.wait()` thread; writer behind
    `Arc<Mutex<Box<dyn Write+Send>>>`.
  - `hanshuaikang/nezha` — the backpressure reference: bounded reader→emitter channel (cap 32) so
    a stalled UI propagates to the kernel PTY buffer; 32 KiB reads, 16 ms flush, 64 KiB max batch.
  - `Flexmark-Intl/maiterm` — the maximalist alternative: `alacritty_terminal` grid + scrollback
    live in Rust, ≤60 fps coalesced frame emission, xterm.js as a dumb painter. Flood-immune but
    heavy machinery; noted as the escalation path, not v1.
  - `sstraus/tuicommander` — domain-closest (orchestrates dozens of AI-agent terminals on
    portable-pty). Useful for any future "agent-in-a-terminal" thinking.

### PTY crate: `portable-pty` 0.9.0 (wezterm) — confirmed choice

The Tauri ecosystem has converged on it (15+ apps found). API: `native_pty_system()
.openpty(PtySize)` → `PtyPair{master, slave}`; `slave.spawn_command(CommandBuilder)` (argv + env
+ cwd; `get_shell()` resolves `$SHELL`/passwd db); `master.try_clone_reader()` / `take_writer()`
/ `resize()` (thread-safe `&self`, delivers SIGWINCH). **Strictly blocking std::io — a dedicated
reader thread per session is mandatory**, which matches the recommended design anyway. Each
non-obvious macOS fact below becomes a code comment or a test:
- **`drop(pair.slave)` immediately after spawn** — the reader only sees EOF (`EIO` → `Ok(0)`)
  once every slave fd is closed.
- Always `take_writer()`, and drop it before `child.wait()`; run `wait()` on its own thread
  (maintainer guidance, wezterm discussion #2392).
- Its `pre_exec` closes all fds>2 (a Cocoa fd-leak defense — written for exactly this host
  shape), but **open bug wezterm#7893** (2026-07-02, reproduced on this Darwin version): that
  sweep also closes Rust's CLOEXEC exec-error pipe, so a failed `execve` (bad program path)
  aborts the child while spawn returns `Ok` — undetectable at spawn time. **Mitigation:
  pre-validate the shell path before spawn.**
- Alternatives dismissed: `pty-process` (real async but no Windows), `alacritty_terminal`
  (drags in full VT emulation — wrong shape when xterm.js is the emulator), `rustix-openpty`
  (too low-level, no session management).

### Transport: `tauri::ipc::Channel`, not events — load-bearing

- Tauri's own docs disqualify events: payloads "are always JSON strings… not suitable for bigger
  messages"; the event system "is not designed for low latency or high throughput". Every `emit`
  is `serde_json::to_string` + an `evaluate_script`, with documented failure modes under
  sustained emit pressure (tauri#8177 crash, #10987 panic, **#12724 open memory leak — ~1.1 GB
  frontend growth over 2M events**). Nightcore's `nc:*` events stay for board/session state;
  they are the wrong pipe for PTY bytes.
- `Channel` is the sanctioned streaming primitive ("used internally for streaming operations
  such as… child process output"): passed as a command argument, ordered via index-based
  reassembly on the JS side, **binary-capable** (`InvokeResponseBody::Raw(Vec<u8>)` arrives as an
  ArrayBuffer — no JSON, no base64). Delivery is dual-path: small payloads by script-eval,
  larger ones pulled through an internal custom-protocol fetch — so coalescing into ≥1 KiB
  chunks keeps bulk output on the fast binary path. Benchmarks are sparse but directional
  (the Tauri 2 raw-IPC rewrite took a 150 MB response ~50 s → <60 ms; ~10 MB binary IPC ≈ 5 ms
  on macOS).
- **No built-in backpressure** (`Channel::send` is fire-and-forget) — flow control is app-level.
  xterm.js parses 5–35 MB/s and its write buffer is hardcoded at **50 MB, then silently
  discards**; the official xterm pattern is watermark flow control via `term.write(chunk,
  callback)` completion callbacks (attach a callback every ~100 KB; pause above ~100 KB in
  flight, resume below ~10 KB) driving `terminal_pause`/`terminal_resume` commands that stop the
  Rust reader loop — which fills the kernel PTY buffer, which stalls the child. That, plus the
  capped Rust transient buffer, is the complete flood story.

### WKWebView quirks (macOS) — the trap list

- **WebGL**: WebGL2 works (ANGLE/Metal since Safari 15), but WebKit hard-caps **16 live GL
  contexts** and force-loses the oldest *unrecoverably*; and **xtermjs#5816 is OPEN** — broken
  WebGL rendering on macOS 26.5 beta, *reported from a Tauri app*, with no canvas renderer left
  to fall back to in xterm 6. ⇒ Reinforces the v1 call: **DOM renderer only**. If WebGL is ever
  enabled (multi-terminal grid), wire `addon.onContextLoss(() => addon.dispose())` (xterm then
  auto-falls back to DOM) and put it behind a GPU toggle, VS-Code-style.
- **The Edit-menu trap**: Cmd+C/V/X/A dispatch through the NSMenu responder chain. Tauri v2's
  default menu carries the required roles — but **replacing it with a custom app menu that lacks
  the predefined Edit items silently kills copy/paste in the whole webview** (tauri#11422).
  Nightcore ships the default menu today; leave a guard note for whenever a custom menu lands.
- **Clipboard**: WebKit demands a live user gesture for `navigator.clipboard.writeText` —
  copy-on-select and OSC 52 writes originating from PTY output will reject. Route through the
  Tauri clipboard-manager plugin (NSPasteboard, no gesture constraint) via
  `@xterm/addon-clipboard`'s pluggable `IClipboardProvider`.
- **Key repeat**: macOS press-and-hold (the accent picker) eats held-key auto-repeat inside
  webviews — set `ApplePressAndHoldEnabled=false` per-app (VS Code's long-standing fix).
- **Retina check**: WKWebView has a known bug class where custom-URL-scheme content (production
  Tauri builds serve via `tauri://`) doesn't receive the backing scale factor — Wails shipped a
  P1 blurry-xterm fix for exactly this. No Tauri report found, but **verify
  `devicePixelRatio === 2` in a production build**, not just the :5173 dev build.
- Keep focus on xterm's hidden textarea (else macOS beeps per keystroke); suppress the default
  right-click menu inside the terminal pane; expose `macOptionIsMeta` as a setting (default off).

### xterm.js in 2026

`@xterm/xterm` **6.0.0** (2025-12-22; actively iterated, 6.1 betas current). Canvas renderer
removed — the chain is WebGL → DOM, nothing in between. Addons republished in lockstep: fit
0.11, search 0.16, web-links 0.12, unicode11 0.9, clipboard 0.2 (OSC 52 + pluggable provider),
serialize 0.14 (Aperant-style remount replay). `allowProposedApi: true` is now needed **only for
the unicode addons** (5.x folklore about search/decorations is obsolete). React wrappers are
abandoned or 6-incompatible — the 2026 norm (VS Code, Tabby, JupyterLab) is direct imperative
integration (ref + effect + dispose), which is exactly Nightcore's folder-per-component + hooks
shape anyway. Set `customGlyphs: true` for box-drawing. ghostty-web exists as a challenger but
is pre-1.0; xterm.js remains the only serious option.

### How this maps onto Nightcore's existing plumbing

Verified against the tree (2026-07-10):

- **Events today**: Rust emits JSON payloads on string channels (`nc:session`, `nc:permission`, …
  in `apps/desktop/src-tauri/src/sidecar/channels.rs`) via `app.emit`; the web side wraps
  `listen` with zod narrowing in `apps/web/src/lib/bridge/events.ts`. Nothing uses
  `tauri::ipc::Channel` yet — the terminal is the first consumer that actually needs a
  streaming primitive rather than broadcast events.
- **Commands today**: thin handlers in `apps/desktop/src-tauri/src/commands/*` registered in
  `lib.rs`, bridged in `apps/web/src/lib/bridge/commands/*.ts` with zod re-validation. The
  Tauri-command threading trap applies (`reference_tauri_command_threading`): PTY commands must
  be `async` + never hold the main thread; the PTY reader lives on its own thread anyway.
- **No PTY dependency exists** (`Cargo.toml` has tauri + dialog/notification/updater/process
  plugins only). No `Channel`, no shell plugin.
- **Worktree paths** resolve via `worktree::path::worktree_path(project, task_id)` →
  `<project>/.nightcore/worktrees/<taskId>`; the terminal's cwd comes from the store, not the UI.
- **The sidecar is the wrong tier for the PTY.** It is the *agent engine* (compiled Bun binary,
  externalBin, stdio-NDJSON to Rust). Routing user-terminal bytes Rust→Bun→Rust→webview adds two
  hops and a process boundary for nothing; `bun compile` + node-pty native modules is fragile;
  and coupling a user affordance to the agent engine's lifecycle (which is killed/recovered on
  crash — `handle_sidecar_crash`) is exactly the coupling the backend decomposition removed.
  **PTY belongs in the Rust core.**

### Recommended architecture (tier by tier)

**Rust core (`apps/desktop/src-tauri/src/terminal/`)** — new module, sibling of `worktree/`:
- `portable-pty` 0.9 for spawn: `openpty` → `CommandBuilder` with the user's `$SHELL`
  (pre-validated on disk — wezterm#7893 makes a bad path abort undetectably), `-i` like
  omniscribe, cwd = worktree path resolved from the store, env: inherit + force
  `TERM=xterm-256color`/`COLORTERM=truecolor`, strip Nightcore-internal vars. Then
  **`drop(slave)` immediately**, `take_writer()` up front (behind `Arc<Mutex>`), `clone_killer()`
  as a drop-guard, and `child.wait()` on its own thread (the terax-ai discipline, §2).
- A `TerminalRegistry` in managed state: `HashMap<TerminalId, TerminalSession>` where a session
  owns the PTY master, the writer, a scrollback ring buffer (~500 KB, omniscribe-sized), the
  paused flag, and the reader/waiter thread handles.
- **Reader thread per PTY**: blocking `read()` loop (16–32 KiB reads) → coalescing buffer
  flushed 4–16 ms after first byte or at 32–64 KB, whichever first (chunks ≥1 KiB ride Tauri's
  binary fetch path) → one `Channel::send` of raw bytes. Cap the transient buffer (~4 MB); on
  overflow discard the WHOLE buffer and inject `ESC c` — never a partial cut (a partial cut
  slices an escape sequence and corrupts xterm's parser).
- Commands (`commands/terminal.rs`): `terminal_create(taskId|projectId, cols, rows, channel)`,
  `terminal_write(id, data)`, `terminal_resize(id, cols, rows)`,
  `terminal_pause(id)` / `terminal_resume(id)` (the watermark flow-control seam),
  `terminal_kill(id)`, `terminal_attach(id, channel) -> scrollback`. Create/attach take the
  Tauri `Channel` as a command argument (the documented Tauri 2 streaming pattern; events are
  explicitly disqualified — §2), so each terminal has a dedicated ordered binary stream instead
  of multiplexing over a broadcast `nc:*` event.
- Lifecycle hooks: kill sessions for a task's worktree inside `discard_worktree` /
  merge-cleanup / `delete_task` (same places that remove the dir), and kill-all on app exit.
  SIGTERM → poll → SIGKILL like omniscribe/AutoMaker.

**Web (`apps/web/src/components/terminal/` + `lib/bridge/commands/terminal.ts`)**:
- `@xterm/xterm` 6.0 + addons: fit, search, web-links (links routed through the existing
  hardened `open_external`), unicode11 (`allowProposedApi: true` — needed only for this),
  clipboard with a custom `IClipboardProvider` backed by the Tauri clipboard-manager plugin
  (WebKit's gesture requirement breaks `navigator.clipboard` for copy-on-select/OSC 52 — §2),
  and serialize if remount replay ever prefers client-side state. Direct imperative integration
  (ref + effect + dispose) — the react wrappers are dead/6-incompatible.
- **DOM renderer only in v1** — no WebGL addon: Nightcore shows one terminal at a time (worktree
  drawer/panel), the DOM renderer is fine at that scale, xtermjs#5816 (broken WebGL on macOS
  26.5 beta, repro'd from a Tauri app) is open with no canvas fallback left, and it sidesteps
  WebKit's 16-context limit entirely. omniscribe's `webglPool` + `onContextLoss→dispose` is the
  documented upgrade path if a multi-terminal grid ever ships.
- A `useTerminalConnection`-style hook: rAF write-buffer (omniscribe's third stage), hidden-tab
  buffering with a capped buffer trimmed at newline boundaries, `safeFit`-guarded ResizeObserver
  with ~100 ms debounce → `terminal_resize`, and xterm watermark flow control (write-callbacks
  every ~100 KB → `terminal_pause`/`terminal_resume`).
- Surfaces: a terminal panel on `WorktreeView`/`WorktreeManager` rows and the TaskDetail drawer
  for worktree-mode tasks; one session per worktree by default (allow N later — registry is
  already keyed by TerminalId, not task).
- Bridge mock: a fake echo-PTY in `bridge/mocks.ts` so the :5173 mock web renders a live-feeling
  terminal outside Tauri (this is what makes dogfood:ui able to drive it — §4).

**Sidecar / engine**: untouched. No contract changes beyond (optionally) none at all — terminal
types can live as plain Rust structs + ts-rs codegen like other command payloads.

---

## 3. Security stance: user terminal vs the confinement stack

### Where the existing gates actually live (verified)

Every confinement layer Nightcore has is **agent-session-scoped by construction**:

| Layer | Attachment point | Applies to a Rust-spawned user PTY? |
|---|---|---|
| Workspace confinement (`packages/engine/src/policy/workspace-confinement.ts`) | SDK `PreToolUse` hook inside a Claude session | No — it gates *tool calls*, there is no session |
| Deny/ask/allow runtime tiers + destructive deny (`policy/tool-deny-policy.ts`) | Same SDK hook bus | No |
| Seatbelt write sandbox (`providers/claude/sandbox.ts`) | `sandbox-exec` wrapper around the spawned `claude` executable | No — it wraps the agent binary, not shells |

So "does the user terminal respect confinement" is not a toggle we'd flip — it's a system we'd
have to *build*. That framing matters for the decision.

### The options

**(a) Fully unconfined — same trust as Terminal.app.** The terminal is a convenience replacing
"cd into `.nightcore/worktrees/<id>` in iTerm". The user can already do anything in any other
terminal; confining them adds no security, only friction (can't `brew install`, can't edit
dotfiles, mysterious EPERMs). This is what all three references do — AutoMaker (allow-all by
default), Aperant (explicitly: entitlements opened up *for* terminals, no App Sandbox),
omniscribe (env hygiene only). The real risks at this tier are not "the user escapes" but:
  1. **Seam leakage** — an agent-reachable path into the PTY. Mitigation is structural: PTY
     commands are Tauri commands, invokable only from the webview; agents talk to the sidecar
     SDK and never hold a Tauri IPC handle. Keep it that way — never expose a "run in user
     terminal" MCP tool, never auto-type agent output into the PTY, and require an explicit user
     gesture (button/keystroke in the webview) for `terminal_create`/`terminal_write`.
  2. **Identity confusion** — a user pastes something an agent "suggested" into a surface that
     looks like agent activity but carries full user privilege. Mitigation is visual: distinct
     chrome (label "Your terminal — full permissions, outside agent guardrails", different
     accent from agent transcript surfaces), and terminal output never intermixed with agent
     transcript panes.
  3. **Escaped-bytes hygiene** — worktree/task-derived strings that reach the shell (cwd,
     branch names in a title) must be spawn-arg'd, never interpolated into a shell string.
     `portable-pty`'s `CommandBuilder` takes argv + cwd directly; no shell-string assembly.

**(b) User terminal respects workspace confinement.** Would mean wrapping the shell in the
Seatbelt profile (`sandbox-exec -f <profile> $SHELL -i`) — technically cheap on macOS since the
deny-write-except profile logic exists (in TypeScript; it would need a Rust port or a generated
profile file), but: it breaks ordinary dev flows the terminal exists to serve (global installs,
`~/.gitconfig` edits, caches outside the allowed roots), confuses users with EPERMs that look
like bugs, and stops nobody — the user opens Terminal.app and does it anyway. The PreToolUse
lexical gate cannot apply at all (there are no tool calls to inspect). Rejected as a default.

**(c) Tiered/configurable** — a Settings toggle "confine user terminals to the worktree
(experimental, macOS)" that applies the Seatbelt write-profile to the shell, default OFF. This
is a coherent *future* option (it reuses the sandbox seam and gives a "feel what the agent
feels" debugging mode), but it is scope without a user: nobody has asked for it, and it drags
the TS→Rust profile port into v1.

### Recommendation

**Ship (a), unconfined, with the visual-identity and no-agent-seam rules above as hard
requirements.** Note in Settings copy that user terminals run outside agent guardrails. Keep (c)
in the back pocket as an opt-in follow-up if the tiered-sandbox roadmap (control-panel roadmap,
LOCKED decision "tiered sandbox") later wants a "governed terminal" story.

**How this is distinct from agent shells, stated for the record:** agent Bash runs inside an SDK
session where PreToolUse hooks fire under `bypassPermissions` and the opt-in Seatbelt wraps the
`claude` binary; those guarantees derive from the session, and a user PTY has no session. If a
future feature ever runs an *agent* inside a PTY (Aperant-style agent terminals), it must NOT
reuse the user-terminal spawn path — it would need the sandbox wrapper + its own containment
derivation. One spawn path per trust level.

This is genuinely a user-decidable point only in degree: (a) vs (c)-later is a product-taste
call. (b)-as-default is not recommended under any framing. → Listed in §6.

---

## 4. Testing strategy (omniscribe-informed, adapted to Nightcore's harness)

Nightcore constraint: the live Tauri window is WKWebView — **no CDP**; UI dogfooding runs
against the mock web on :5173 (`bun run dogfood:ui`), engine dogfooding via
`dogfood:engine`. Web unit tests already run in **vitest browser mode (real Chromium via
Playwright)** — which is *better* than the Electron apps' jsdom setups: real xterm can actually
render in component tests here, though the omniscribe rule (mock xterm at the hook seam) still
applies for logic tests.

Layered plan, mirroring omniscribe's five layers:

1. **Rust unit (service layer, no real PTY)** — put the PTY behind a small trait
   (`trait Pty { read/write/resize/kill }`) exactly like omniscribe's `node-pty.mock.ts` fakes
   `IPty`. Test with a scripted fake: coalescer flushes at the 4–16 ms boundary and the
   32–64 KB cap (fake clock), overflow discards the WHOLE buffer + injects `ESC c` (never a
   partial cut), pause/resume actually halts and resumes the reader (the flow-control seam),
   scrollback ring semantics, registry lifecycle (create/attach/kill idempotency,
   kill-on-worktree-discard), resize validation (rounds, rejects 0/negative — omniscribe
   asserts exactly this), shutdown guard (data/exit after teardown is ignored — Aperant's
   SIGABRT lesson as a test).
2. **Rust integration (real PTY, no webview)** — spawn `/bin/sh -c 'printf …'` through real
   `portable-pty`, assert bytes traverse the reader→coalescer→subscriber seam; one test for
   SIGTERM→SIGKILL escalation with a `trap`-ing child; one for the invalid-shell-path guard
   (wezterm#7893 makes the un-guarded case return `Ok` while the child aborts). Runs in
   `cargo test` on macOS CI (the `rust-checks` job); keep them `#[cfg(unix)]`.
3. **Web hook/unit (vitest, xterm mocked)** — omniscribe's exact playbook: `useTerminalConnection`
   with a stubbed rAF queue + `{write: vi.fn()}` xterm ref (rAF coalescing, hidden-buffer cap,
   flush-on-visible, unmount flush); `safeFit` guard table + resize debounce with fake timers;
   bridge wrapper zod round-trips.
4. **Web component (vitest browser mode, real xterm, mock bridge)** — mount the Terminal
   component against the echo-mock bridge; type, assert echoed cells render; assert the
   "unconfined" identity chrome renders. This layer is a Nightcore upgrade omniscribe couldn't
   have in jsdom.
5. **dogfood:ui (Playwright vs :5173 mock web)** — extend `scripts/dogfood-ui.mjs`: open a
   worktree's terminal, type into the echo mock, screenshot, assert no console errors. Like
   omniscribe's e2e, deliberately do NOT assert real shell output (env-dependent); the
   create→render→input→echo pipeline is the contract. Real-PTY verification stays manual +
   Rust layer 2 (the Tauri window can't be driven).

Deliberate non-tests (encode omniscribe's philosophy): no real-shell output assertions in
CI, no real WebGL, no xterm rendering pixel tests; time is always faked at throttle/debounce
boundaries; known trust-model decisions (unconfined terminal) get an *asserted* test with a
comment, not a pretend gate.

---

## 5. Open-in-editor / reveal-in-Finder (the trivial sibling)

Current state: Nightcore's only opener is `open_external` (https-only, hardened —
`workflow/pr/open.rs`). No reveal, no editor launch. Notably **neither Aperant nor omniscribe
has reveal-in-Finder either** (both only `shell.openPath`/protocol URLs); AutoMaker's
`libs/platform/src/editor.ts` is the best-in-class reference.

Design (all Rust core, `commands/` + a small `infra/editor.rs`):

- **`reveal_worktree(task_id | project_id)`** — resolve the path from the store (never accept a
  raw path from the webview — mirrors the `open_external` posture and closes the "webview asks
  to reveal `~/.ssh`" class), verify it exists and is the project root or under
  `.nightcore/worktrees/`, then macOS `open -R <path>` (reveal-and-select in Finder; `open`
  alone opens *inside* the dir — AutoMaker/Aperant use the latter, `open -R` is the nicer
  affordance), Linux `xdg-open <dir>`, Windows `explorer /select,<path>`. Reuse the existing
  `spawn_and_reap` pattern from `pr/open.rs`.
- **`open_in_editor(task_id | project_id)`** — AutoMaker's detection order, trimmed: CLI-first
  via `which` (`cursor`, `code`, `zed`, `subl`, `webstorm`, …), then macOS app-bundle fallback
  (`/Applications/*.app` → `open -a <bundle> <path>`). Cache detections (AutoMaker uses a 5-min
  TTL). Persist the user's pick in Settings (`preferred_editor: Option<String>`, serde-additive)
  with a one-time picker; a plain `editor_cli <path>` spawn (argv, no shell). Protocol URLs
  (`vscode://file/...`) are an alternative (omniscribe's approach) but the CLI covers more
  editors uniformly and supports `path:line:col` later for finding-jump integration.
- **UI**: actions on WorktreeManager rows, WorktreeView, and TaskDetail for worktree-mode tasks
  (the companion gap-doc already earmarks TaskDetail for discard/open affordances); plus on the
  project row for repo-root. Bridge wrappers in `lib/bridge/commands/worktrees.ts`.
- **Security note**: both commands are pure user-gesture conveniences; keeping path resolution
  server-side means they add no new writable/exec seam an agent could reach.

Effort: ~0.5–1 day including tests (detection matrix is a pure-function table test).

---

## 6. Decisions the user must make

1. **Security presentation (§3)** — accept the recommended unconfined-with-identity stance (a),
   or ask for the opt-in Seatbelt "confined terminal" toggle (c) in v1? Recommendation: (a) now,
   (c) only if the tiered-sandbox roadmap wants it later. (b) — confinement as default — is
   recommended against outright.
2. **Terminal lifetime on worktree cleanup** — when a worktree is discarded/merged with
   `cleanupWorktrees` on, live terminal sessions in that dir: kill silently, or block the
   cleanup with a "terminal still open" confirm? Recommendation: kill with a toast (matches the
   references; a shell in a deleted cwd is useless anyway) — but it's a UX-taste call.
3. **Session persistence scope** — v1 proposal: sessions survive UI navigation (they live in
   Rust) but NOT app restart (no disk persistence of scrollback). Aperant persists to disk;
   omniscribe survives socket loss only. Restart-persistence is real extra scope (serialize +
   restore + stale-session pruning) for marginal value in a desktop app. Confirm v1 = no
   restart persistence.
4. **Where the terminal lives in the UI** — per-worktree panel inside WorktreeView/TaskDetail
   (recommended v1), vs a global Terminal view with tabs (AutoMaker-style). Affects layout work,
   not the backend.
5. **Editor launch mechanism** — CLI-first detection (recommended, AutoMaker-style, enables
   `file:line:col` later) vs protocol-URL allowlist (omniscribe-style, smaller but VS-Code-family
   only).
6. **One terminal per worktree or N?** v1 recommendation: one (plus the external-terminal
   escape hatch is always there); the registry design doesn't preclude N later.
7. **Renderer: DOM-only v1 (recommended) or ship a WebGL toggle now?** WebGL buys throughput on
   heavy streaming output, but xtermjs#5816 (WebGL corruption on macOS 26.5 beta, repro'd from a
   Tauri app) is open and the only fallback is DOM anyway. Recommendation: DOM v1, revisit
   WebGL+`onContextLoss` fallback behind a GPU toggle if terminal-grid or agent-log-streaming
   use cases arrive.

## 7. Effort estimate

| Slice | Scope | Estimate |
|---|---|---|
| Rust `terminal/` module | portable-pty session registry, reader/coalescer, scrollback ring, kill lifecycle + worktree-cleanup hooks, commands + Channel wiring, unit + real-PTY tests | 2–2.5 d |
| Web terminal | xterm component (folder-per-component, ≤400-line ratchet), connection/resize hooks, echo bridge mock, panel placement in WorktreeView/TaskDetail, hook + browser-mode tests | 2–2.5 d |
| Open-in-editor/Finder | 2 commands + detection + settings field + UI actions + tests | 0.5–1 d |
| dogfood + polish | dogfood:ui extension, identity chrome, docs | 0.5–1 d |

**Total ≈ 5–7 focused days** — consistent with the roadmap's "cheapest expected gap" framing.
Natural split for the worktree/ship workflow: slice 1 (Rust backbone) → slice 2 (web) can run
staged like the PR-system builds; open-in-editor is independent and can land first as a
quick win (the gap doc already lists it as such).

## 8. Risks & gotchas (collected)

- **Naive emits are the failure mode** — Aperant ships per-chunk `webContents.send` with no
  batching and gets away with it only because Electron IPC is cheap; Tauri events JSON-wrap
  through an `evaluate_script` per emit with an OPEN memory-leak issue under sustained pressure
  (tauri#12724), so the Rust-side coalescer + `ipc::Channel` is *required*, not optional.
- **Flow control is app-level or nothing** — `Channel::send` is fire-and-forget and xterm's
  write buffer silently discards past 50 MB; without the watermark pause/resume loop a `yes` or
  giant build log eventually drops bytes invisibly.
- **Failed `execve` is invisible on macOS** — open wezterm#7893 (repro'd on this Darwin): spawn
  returns `Ok` while the child aborts. Pre-validate the shell path; surface "exited immediately"
  as a distinct UI state.
- **Sync Tauri commands block WKWebView** (`reference_tauri_command_threading`) — all terminal
  commands async; writes go through a non-blocking send to the session's writer.
- **Shutdown races crash natively** — Aperant's lesson: PTY callbacks firing into a torn-down
  window SIGABRT. The registry needs a shutdown guard and reader threads must tolerate a closed
  channel. Same class as `drop(slave)`/writer-before-`wait()` ordering (§2).
- **The Edit-menu trap** — if a custom macOS app menu ever replaces Tauri's default without the
  predefined Edit items, Cmd+C/V dies silently in the whole webview (tauri#11422).
- **Key repeat + Retina** — `ApplePressAndHoldEnabled` must be off per-app for held-key repeat;
  verify `devicePixelRatio === 2` in a *production* (`tauri://`-served) build — WKWebView has a
  known custom-scheme scale-factor bug class (Wails shipped a P1 blurry-xterm fix for it).
- **Unchanged-dimension resize** — after re-showing a TUI, force a SIGWINCH cycle
  (resize cols−1 then cols) so full-screen programs repaint (Aperant's trick).
- **Paste flooding** — chunk large writes (8 KB chunks / ≥10 ms spacing, per all three refs)
  and cap paste size (~1 MB).
- **Buffer-overflow discipline** — on transient-buffer overflow discard the whole buffer and
  inject `ESC c`, never a partial prefix (a partial cut slices an escape sequence and corrupts
  xterm's parser state).
- **Scrollback replay race** — attach must deliver scrollback *before* subscribing live output
  (AutoMaker's connected→scrollback→subscribe ordering).
- **Login vs interactive shell** — omniscribe's `-i`-not-`--login` choice (sources rc like VS
  Code) is the right default; document it.
- **GUI PATH problem** — a Tauri app launched from Finder inherits a minimal PATH; the shell
  itself re-sources rc files so the *terminal* is fine, but editor CLI detection should use the
  login-shell PATH resolution trick (omniscribe's `shell-path.ts`) or `open -a` fallbacks.
