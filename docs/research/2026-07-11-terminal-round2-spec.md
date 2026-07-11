# Build spec: terminal cockpit round 2 (AI naming, broadcast, drag-drop, daemon hardening)

**Date:** 2026-07-11
**Status:** build-ready. Every decision in § 1 is locked (user-grilled 2026-07-11). Do NOT
re-litigate; implement.
**Extends (read first, authoritative for the shipped backbone + hard constraints):**
`docs/research/2026-07-11-terminal-cockpit-spec.md` — the shipped cockpit: `terminal/` registry
(cap **12**), `terminal/daemon/` (Unix-only detached PTY daemon), grid view + `@dnd-kit/core`
reorder, task injection (`terminal-tasks.ts`), worktree-create picker, manual rename, the
USER-ONLY seam. This round layers four additive features on top; the daemon is the only place a
prior decision (**PR 5 "NO AI auto-naming in v1"**) is now reopened — see § 10.1.
**Idiom prior art:** `docs/research/2026-07-11-usage-meter-spec.md` (serde-additive Settings, ts-rs
regen-and-diff, the trap-list format).

> Four PRs, **in this order**: **A** (AI auto-naming) → **B** (broadcast input) → **C** (drag file
> → path) → **D** (platform hardening — riskiest, LAST). A/B/C are additive over the shipped web +
> registry; **PR D is the only structural change** (Windows daemon parity + Unix peer-cred) and
> must land without any of A/B/C depending on it. Each PR is independently green against § 8.

---

## 1. Decision record (grilled 2026-07-11 — recorded verbatim, do not reopen)

| PR | Locked scope |
|---|---|
| **A — AI auto-naming (opt-in)** | **Settings-gated, DEFAULT OFF.** Capture the **last non-trivial command** web-side (Enter-detection on xterm `onData`; skiplist `cd`/`ls`/`git`/`clear`/etc.), **debounce (~1.5s idle)**, then a **Rust command wrapping the existing one-shot `claude -p` haiku seam** (`workflow/oneshot.rs`) returns a **2–3 word title**. **Manual rename ALWAYS wins** (a manually-renamed session never auto-renames). **Once-per-idle-period.** **Task-linked titles (PR-4 linkage) also win** over AI names. |
| **B — Broadcast input** | A **grid-mode toggle**; when armed, keystrokes typed in the **focused pane fan out to ALL visible panes** via the existing write path. **LOUD active indicator** (colored border/badge on **every** receiving pane + the toggle). **Paste + IME** considerations. **Auto-disarm on leaving grid view.** |
| **C — Drag file → path** | Drop a file/folder onto a pane **types the shell-escaped absolute path at the prompt (no newline)**. Webview drop-event plumbing (Tauri v2 native file drops — `dragDropEnabled` / `onDragDropEvent` — and any config flag currently set). **Multi-file = space-separated escaped paths.** |
| **D — Platform hardening (riskiest, LAST)** | **Windows daemon parity** for live-PTY survival (**`DETACHED_PROCESS` spawn + named-pipe IPC** mirroring the Unix socket protocol in `terminal/daemon/`) **+ Unix `SO_PEERCRED`/`LOCAL_PEERCRED` uid verification** on the daemon socket (**requires adding a `libc` or `nix` dep — note the lockfile/审 review implication and pick the smaller**). Windows keeps **read-only-restore fallback** when the daemon flag is off; **all PR-6 degradation invariants preserved.** |

**Hard constraints carried forward (do not violate):**

- **USER-ONLY seam.** No command, event, or store path may make a PTY, the daemon socket/pipe, or
  any new command reachable from an agent session. AI auto-naming spawns a *sandboxed, read-nothing*
  `claude -p` (all tools disallowed — § 3.A.4), and broadcast/drag-drop write into the human's own
  PTY on explicit gestures. None of it is the agent driving a shell.
- **Additive-only for A/B/C.** New fields on `TerminalSessionInfo`, `PersistedScrollback`, and
  `Settings` evolve serde-additively (every prior field does). No breaking migration.
- **Daemon degradation is sacred (PR D).** Every failure path (daemon absent / dead / version-skew /
  platform-unsupported) still degrades to the shipped **in-process PTY + read-only scrollback
  restore**. Windows parity is a *capability add* behind `terminal_daemon_enabled`; when the flag is
  off, or the daemon is unreachable, Windows behaves exactly as today.
- **Scrollback may contain secrets.** `.nightcore/terminals/` stays export-excluded; the daemon's
  buffers + socket/pipe stay owner-only (PR D extends this with peer-cred + a Windows DACL).

---

## 2. What exists today (grounding — verified against the shipped tree)

- **Rust `terminal/`**: `registry.rs` (`MAX_LIVE_SESSIONS = 12`, `registry.rs:26`), `session.rs`
  (`PtySession::spawn` `:122-205`; `build_command` `:287-317` which **already scrubs** provider env
  via `scrub_provider_env` `:322-326` from `SCRUBBED_ENV_VARS` `:63-70`; `SpawnOpts` `:73-78` =
  `{cwd, confined, cols, rows}`, **no title field**; `set_title(&self, Option<String>)` `:210-214`
  over `title: Arc<Mutex<Option<String>>>` `:113`), `persist.rs` (`PersistedScrollback.title: String`
  `#[serde(default)]` `:53`, `""`→`None` in `.info()` `:99`), `types.rs`
  (`TerminalSessionInfo.title: Option<String>` `:46`, `PersistedTerminalInfo.title` `:67`),
  `backend.rs` (`TerminalBackend` routes each op to the in-process `TerminalRegistry` or the daemon
  by ownership), `daemon/` (see § 2 daemon below).
- **Commands `commands/terminal.rs`**: `terminal_write(app, id, data: Vec<u8>)` `:119-124`,
  `terminal_set_title(app, id, title: Option<String>)` `:130-141` (+ `normalize_title` `:146-150`),
  `terminal_spawn`/`resize`/`kill`/`list`/`sessions_in_dir`/`list_persisted`/`read_persisted`/
  `delete_persisted`. All async + `spawn_blocking`.
- **Web `components/terminal/`**: `terminal-session-manager.ts` (module-level session owner; the
  input path `attachSession` `:336-338` `entry.term.onData((data) => writeTerminal(id, encode(data)))`;
  the output callback `installSession` `:243-246` `term.write(bytes); recordActivity(id)`;
  `visibleIds` module set `:97` set via `setVisibleTerminals` `:140-143`), `terminal-layout.ts`
  (`visibleIds` memo `:182-188`: grid → all ordered ids or `[zoomedId]`, tabs → `[activeId]`),
  `terminal-keymap.ts` (`installKeymap` `:140-166` via `attachCustomKeyEventHandler`; clipboard /
  Shift-Enter / kill-line emit via `writeTerminal` at `:159,:162`), `terminal-rename.ts`
  (`useInlineRename` `:45-112`; header comment "Rename is MANUAL only"), `terminal-tasks.ts`
  (`injectTask` `:110-118`, **auto-takes the task title** at `:116`
  `renameSession(session.id, task.title)`), `terminal-shared.ts` (`displayTitle` `:90-93` =
  `title?.trim() || cwdLeaf`; `TERMINAL_SESSION_CAP = 12` `:19`; `gridColumns` `:175-180`),
  `TerminalView/` (`useTerminalView`: `activeId` `:57`, `selectTab` `:256`, `renameSession`
  `:262-267`), `TerminalTabs/`, `TerminalPane/` (drop target div `containerRef`/`rootRef`
  `TerminalPane.tsx:150-151`), `TerminalGrid/` + `TerminalGridPane/` (root div `data-session-id`
  `TerminalGridPane.tsx:103`, border chrome `:104`, header badge row `:108-144`, `containerRef`
  `:146`). Bridge `lib/bridge/commands/terminal.ts` (`setTerminalTitle` `:144-148`,
  `writeTerminal` `:130-137`, `spawnTerminal` Channel `:71`; **dynamic** `@tauri-apps/api/core`
  import inside `isTauri()` branches).
- **Daemon `terminal/daemon/`** (Unix-ONLY): `mod.rs` `#[cfg(unix)]` gates `client`/`fanout`/
  `protocol`/`server` `:33-47`; `server.rs` `#![cfg(unix)]` (`std::os::unix::net::UnixListener`),
  `client.rs` `#![cfg(unix)]`; `discovery.rs` `daemon_supported() = cfg!(unix)` `:22-24`,
  `spawn_detached` `:112-147` (`setsid()` via raw `extern "C"` `:135-140`, `.process_group(0)`,
  stdio→`/dev/null`), `euid()` raw FFI `:49-58`, `socket_base_dir()` 0700 `:64-75`,
  `set_socket_perms` 0600 `:97-99`, **the deferred peer-cred comment** `:12-16`; `launch.rs`
  Windows path = `eprintln!` + `exit(1)` `:18-24`; `server.rs` `run()` bind + chmod `:222-231`,
  `Server { registry: TerminalRegistry, … }` `:35-48`; `fanout.rs` `REPLAY_BUDGET_BYTES = 1 MiB`
  `:32`. **Socket transport is std blocking `UnixListener`/`UnixStream` + `std::thread`** — no
  tokio, no `interprocess`. **`Cargo.toml` has NO `libc`/`nix`/`interprocess`** (setsid/geteuid are
  raw `extern "C"`).
- **Settings `store/settings/model.rs`**: the serde-additive terminal knobs
  (`terminal_webgl_enabled` `:123`, `terminal_confined_default` `:131`, `terminal_font_size` `:140`,
  `terminal_scrollback` `:147`, `terminal_yolo_launch` `:166`, `terminal_daemon_enabled` `:180`) —
  the exact `#[serde(default)]` idiom every new flag below follows.

**⚠️ Five shipped-code facts that shape the PRs (full flags in § 10):** (1) **AI auto-naming was
explicitly OUT in the cockpit spec** — `terminal-rename.ts:9-11` and `model.rs` still say "manual
only"; PR A reopens it. (2) **Title is a single `Option<String>` with NO manual-vs-auto flag** —
"manual/task wins" needs a NEW title-source bit. (3) **`build_command` already scrubs provider env**
— PR A needs no env work. (4) **No native file-drop exists** and **`dragDropEnabled` is unset**
(defaults Tauri-v2 `true` → HTML5 file `ondrop` is suppressed; native drops arrive via
`onDragDropEvent`). (5) **The daemon is Unix-only with NO peer-cred and NO `libc`/`nix` dep** — PR D
is greenfield on both axes.

---

## 3. PR slicing (locked — four PRs, each independently green; order is build order)

### PR A — AI auto-naming (opt-in, settings-gated OFF)

**A.1 The setting.** New global flag `terminal_ai_naming: bool` (`store/settings/model.rs`,
`#[serde(default)]`, **default false**), mirroring `terminal_webgl_enabled` exactly; + the
`SettingsPatch` `Option<bool>` twin + `Default` + merge line; a Settings toggle labeled
*"Auto-name terminal tabs (uses `claude` haiku on the last command)"*. `cargo test` regenerates
`Settings.ts`.

**A.2 The title-source bit (the load-bearing new field — decision "manual/task wins").** Today the
title is a single `Option<String>` written identically by manual rename, task auto-take
(`terminal-tasks.ts:116`), and (now) AI — with **no way to tell them apart** (§ 10.2). Add a
**precedence source** so AI never clobbers a human or task title:

- **Rust:** add `title_source` to `TerminalSessionInfo` (`types.rs`), `PersistedTerminalInfo`
  (`types.rs`), and `PersistedScrollback` (`persist.rs`, `#[serde(default)]` — additive, **no `v`
  bump**), plus a field on the live `PtySession` (behind the registry `Mutex`, beside `title`).
  Model it as a small enum ranked **`Manual (3) > Task (2) > Auto (1) > Unset (0)`** — serialize
  camelCase to a TS union (`"manual" | "task" | "auto"`, `Option` on the wire; legacy → `None`).
- **The write API carries the source.** Extend `terminal_set_title` to
  `terminal_set_title(app, id, title: Option<String>, source: TitleSource)` (or add a sibling
  `terminal_set_title_auto`), and **guard the write in Rust under the registry lock**: a write only
  lands if `incoming_source >= current_source` **OR** the incoming is `Manual`/`Task` (a human or
  task always wins and *raises* the source; an `Auto` write is refused when the current source is
  `Manual`/`Task`). Manual rename ⇒ `Manual`; `injectTask` auto-take (`terminal-tasks.ts:116`) ⇒
  `Task`; AI ⇒ `Auto`.
- **Legacy-safety (critical):** a session written before this feature has `title = Some(...)` but
  `title_source = None`. Treat **"non-empty title + `None` source" as Manual-equivalent** — AI must
  **not** auto-rename a session that already carries a title with no recorded source (a pre-existing
  human rename). AI is eligible **only** when the effective source is `Auto`/`Unset` (title empty or
  explicitly auto). Unit-test this exact case.

**A.3 Web-side command capture (Enter-detection + skiplist + debounce).** The single keystroke path
is `attachSession`'s `onData` (`terminal-session-manager.ts:336-338`). Add a per-session
**line-capture** layer there (a small `CommandCapture` module, not React state):

- Accumulate **printable** `onData` bytes into a per-session line buffer; handle backspace
  (`\x7f`/`\b`) by popping; **on `\r`/`\n`, finalize the line** as the candidate command and clear
  the buffer. (This is a *best-effort* reconstruction of the typed line — control sequences / arrow
  keys / reverse-search are ignored; a garbled capture only yields a weaker title, never an error.
  State this limitation.)
- **Skiplist** trivial commands (case-insensitive first token): `cd ls la ll pwd clear cls exit
  git q vi vim nano cat echo which env history` + empty / whitespace-only / a bare path. A skiplisted
  or empty line does **not** trigger naming.
- **Debounce ~1.5s of idle** after a non-trivial command finalizes (no further `onData`), then
  trigger. **Once-per-idle-period:** track the last command that triggered a suggestion per session;
  do not re-suggest for the identical command or until a new non-trivial command→idle cycle occurs.
- Gate the whole capture layer on `terminal_ai_naming` (do not even buffer when off) AND skip
  sessions whose effective title source is `Manual`/`Task` (no point capturing for a locked title).

**A.4 The Rust naming command (wrap the one-shot haiku seam — verified API).** `workflow/oneshot.rs`
exposes `pub(crate) fn run_oneshot(instruction: &str, stdin_payload: &str) -> Option<String>`
(`oneshot.rs:60`): spawns the user's `claude` in headless `-p` mode, `--model haiku`,
`--strict-mcp-config`, **all tools disallowed** (`Bash,Edit,Write,…,Read,Glob,Grep,WebFetch,…`),
30s timeout, **best-effort → `None`**; plus `strip_code_fence` (`:222`) and `cap` (`:208`)
sanitizers. Add `commands/terminal.rs::terminal_suggest_title` (async + `spawn_blocking`, USER-only):

```rust
// async + spawn_blocking (the one-shot is a blocking child spawn)
pub async fn terminal_suggest_title(app, id: String, command: String) -> Result<Option<String>, String> {
    // guard OFF (settings) and non-Auto-eligible sessions server-side too (defense in depth)
    if !ai_naming_enabled(&app) || !title_is_auto_eligible(&app, &id) { return Ok(None); }
    let instruction = "Give a 2-3 word, lowercase title for a terminal tab running the command on \
                       stdin. Reply with ONLY the title, no punctuation.";
    let raw = crate::workflow::oneshot::run_oneshot(instruction, oneshot::cap(&command, 4000));
    let Some(title) = raw.map(|s| sanitize_title(oneshot::strip_code_fence(&s))) else { return Ok(None); };
    // Apply with source = Auto, GUARDED under the registry lock (§ A.2): a manual/task rename that
    // landed during the ~few-second generation still wins. Return the applied title (or None).
    Ok(apply_auto_title(&app, &id, title))
}
```

`sanitize_title` trims, strips a trailing period, caps to ~24 chars / 3 words, and rejects empty /
newline-laden output (fall back to `None`, keeping the cwd-leaf display). **Arg-order trap
(oneshot.rs:151-156):** `run_oneshot` already places the positional prompt before the variadic
`--disallowed-tools` — do not reorder. The command **both generates and conditionally applies** the
title (guarded, atomic under the lock) so "manual/task wins" cannot race the ~2s generation; the web
just triggers it and reflects the returned title through the normal descriptor refresh.

- **Web bridge:** `suggestTerminalTitle(id, command): Promise<string | null>` in
  `lib/bridge/commands/terminal.ts` (dynamic Tauri import, § 9f); outside the webview it degrades to
  `null` (no naming). Called from the debounce trigger in the capture layer.

**Gate battery (PR A):** `bun run lint && lint:meta`; `--filter @nightcore/web typecheck && … test`;
`cargo fmt --all --check` + `cargo test` **from `apps/desktop/src-tauri`** (regenerates
`TerminalSessionInfo.ts` + `Settings.ts` — commit); `dogfood:engine` (enable AI naming, run
`npm run build` → tab renames to ~"build web"; manually rename → subsequent commands do NOT
re-rename; link a task → task title wins; disable the setting → no naming, no capture).

---

### PR B — Broadcast input to all visible panes (grid mode)

**B.1 Broadcast state + toggle.** A grid-only view state `broadcastArmed: boolean` (in
`useTerminalView`, beside `activeId`/`zoomedId`). A **toggle control in the grid header** (beside the
view-mode/zoom controls) arms it. **Available only in grid mode**; **auto-disarm** whenever the view
leaves grid (`viewMode → 'tabs'`) or the visible set collapses to one — wire the disarm to the same
`viewMode`/`visibleIds` source (`terminal-layout.ts:182-188`).

**B.2 The fan-out.** The single origin of typed bytes is the **focused pane's** `onData`
(`terminal-session-manager.ts:336-338`) — only the focused xterm has keyboard focus, so only it
emits. Route that write through a new **`writeToTargets(originId, data)`** helper:

- when `broadcastArmed` → write `data` to **every id in `visibleIds`** (the module set,
  `session-manager:97`/`:140-143`, which is exactly grid's visible panes); else write to `originId`
  only (today's behavior). Keep the self-write (dedupe by set).
- **Route the keymap emit paths through the same helper.** `installKeymap`'s Shift-Enter (`\x1b\n`),
  kill-line (`\x15`), and the **paste** path currently call `writeTerminal(id, …)` directly
  (`terminal-keymap.ts:159,162`) — when armed these must fan out too, or a broadcast "paste"/multiline
  would hit only the focused pane. Funnel all four (onData, multiline, killline, paste) through
  `writeToTargets`.

**B.3 LOUD active indicator (decision "colored border/badge on every receiving pane + the toggle").**
While armed, **every visible pane** shows it is receiving:

- a **colored ring** on the `TerminalGridPane` root border (`TerminalGridPane.tsx:104`, the
  `data-session-id` div `:103`) — e.g. an amber `ring-2 ring-amber-400/70` + a subtle glow, visibly
  distinct from the drag `border-primary/70` and the focus state;
- a **badge** in each pane's header row (`TerminalGridPane.tsx:108-144`, beside the ungoverned
  `BoltIcon` / `PaneUnread` badges) — a small "BCAST" / broadcast-dot chip;
- the **toggle itself** shows the active state.
- Copy lives in `terminal-shared.ts`. The indicator must be unmissable — broadcasting keystrokes to
  N shells is a footgun; the armed state is never ambiguous.

**B.4 Paste + IME.**
- **Paste:** route through `writeToTargets` (B.2). Prefer xterm's `term.paste(text)` per-terminal so
  each receiver brackets correctly if it enabled `?2004h` (the cockpit spec's bracketed-paste note);
  when armed, call the fan-out with the same payload for every visible id.
- **IME:** composed input surfaces to `onData` on commit as normal text, so it fans out naturally.
  Mid-composition (`compositionupdate`) is not broadcast (xterm emits `onData` on commit) — document
  this as best-effort; the committed text broadcasts.

**Gate battery (PR B):** web gates (folder-per-component on any new toggle/indicator component);
`dogfood:ui` (grid with 3 panes → arm → type in one → all three receive; every pane shows the ring +
badge; paste fans out; switch to tabs → auto-disarms; the indicator clears). No Rust change ⇒
`cargo test` only if a shared type moved (it should not).

---

### PR C — Drag a file/folder onto a pane → type its shell-escaped absolute path

**C.1 Transport decision (the shipped-config flag).** `tauri.conf.json` sets **no `dragDropEnabled`**
key → it defaults to Tauri v2 **`true`**, which means the webview's OS-native file drop is handled by
Tauri and the **HTML5 file `ondrop` DOM event is suppressed** (an `ImageDropzone`-style HTML5 handler
would never fire for files, and even if it did, a webview `File` does **not** expose an absolute
path). Therefore **use Tauri's native `onDragDropEvent`**, which delivers **absolute `paths[]` +
position** — and **keep `dragDropEnabled` at its default `true` (no config change)**. Reject the
`dragDropEnabled: false` + HTML5 route: it can't yield absolute paths in the webview (§ 10.4).
`@tauri-apps/api ^2.11.0` (installed) exposes `getCurrentWebview().onDragDropEvent`.

**C.2 Register once, hit-test to a pane.** `onDragDropEvent` is **webview-global**, not per-element.
Register a single listener in `TerminalView` (unlisten on unmount; dynamic Tauri import, § 9f):

- on `over` → hit-test `payload.position` with `document.elementFromPoint(x, y)?.closest('[data-session-id]')`
  and show a **drop-hint overlay** on that pane (reuse the pane container). Panes carry
  `data-session-id` already (`TerminalGridPane.tsx:103`; add the same attribute to `TerminalPane`'s
  container `TerminalPane.tsx:150-151` so tabs mode hit-tests too).
- on `drop` → resolve the target session id the same way; **ignore drops outside any pane**.
- Works for both modes: tabs shows one pane (activeId), grid shows all visible — the hit-test picks
  whichever is under the cursor.

**C.3 Compose + inject.** For the resolved session:

- **shell-escape each absolute path** and, for multiple files, **join with spaces**
  (`escaped(p1) + ' ' + escaped(p2) + …`). Reuse the existing POSIX shell-escape helper the
  claude-launch / worktree-open path already uses to escape a cwd (search `terminal-tasks.ts` /
  `terminal-worktree-open.ts` for the `cd <escaped>` composer); if none is exported, add a small
  `shellEscapePath(p)` (single-quote-wrap, `'\''`-escape embedded quotes) in `terminal-shared.ts`.
- **Type it with NO trailing newline** (the user presses Enter — same rule as task injection):
  `writeTerminal(id, encoder.encode(escapedPaths))` (`lib/bridge/commands/terminal.ts:130-137`).
- POSIX-shell only in v1 (the escaping is POSIX single-quote); a PowerShell path would escape
  differently — gate to POSIX shells (the terminal already resolves the shell family in `shell.rs`),
  matching the cockpit spec's composed-launch posture.

**C.4 DOM attach caveat.** Attach any hint overlay to the pane **container/`rootRef`** div, never to
the xterm host element — the host is `document.createElement('div')` moved between parents by the
session manager (`terminal-session-manager.ts:256-258,:331`), so a listener on it would detach on
relayout. The `onDragDropEvent` listener itself is on the webview, so it is immune; only the visual
hint binds to the container.

**Gate battery (PR C):** web gates; `dogfood:ui` (drag a file from Finder onto a pane → its escaped
absolute path appears at the prompt, unexecuted, awaiting Enter; drag two files → space-separated
escaped paths; drop outside a pane → nothing; a path with spaces/quotes is correctly escaped). No
Rust change.

---

### PR D — Platform hardening: Windows daemon parity + Unix peer-cred (riskiest, LAST)

See § 5 for the full mini-design + risk register. **Nothing in A/B/C depends on this.** PR D is a pure
capability + hardening add that preserves every shipped degradation invariant. Split it internally
**peer-cred first (smaller, Unix), Windows parity second (greenfield, larger)** so the low-risk half
lands even if the Windows half slips to a follow-up (the cockpit spec § 5.6 already sanctions
"macOS/Linux daemon, Windows on read-only-restore" as an acceptable shape).

**D.1 Unix `SO_PEERCRED` / `LOCAL_PEERCRED` uid verification (do FIRST).** Today the daemon socket is
authenticated by **filesystem permissions only** (0700 dir `discovery.rs:73`, 0600 socket
`set_socket_perms:97-99`); the peer-cred check is a **deferred TODO** (`discovery.rs:12-16`). Close
it: on **each accepted connection** in the server accept loop (`server.rs:222-231`), verify the peer
uid equals our `euid()` (`discovery.rs:49-58`); on mismatch, **log at WARN + drop the connection**
(never serve it). Platform split:
  - **Linux:** `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` → `struct ucred { pid, uid, gid }`.
  - **macOS / BSD:** `getpeereid(fd, &uid, &gid)` (simplest cross-BSD) or `LOCAL_PEERCRED`.
- **Dependency decision (locked ask: "add `libc` or `nix`, pick the smaller"):** the codebase
  **already** does raw `extern "C"` FFI for `euid`/`setsid` (`discovery.rs:49-58,135-140`) with **no
  dep**. The smallest, most consistent path is to **extend that FFI** with `getpeereid` (a trivial
  2-out-param call, macOS/BSD) and `getsockopt`+`ucred` (Linux) — **zero new dependency**. If the
  Linux `ucred` layout is judged too fiddly to hand-declare, add **`libc`** (pure FFI declarations,
  tiny, near-certainly already transitively in `Cargo.lock`) — **not `nix`** (nix layers safe
  wrappers + more transitive weight; it is the *larger* of the two). **Recommendation: no-dep FFI
  extension; `libc` as the fallback; never `nix`.** Either dep addition triggers the lockfile diff +
  the security/审 review (`.cargo/audit.toml`) — call it out in the PR body.

**D.2 Windows daemon parity (greenfield, riskiest — do SECOND).** Today Windows has **no daemon**:
`daemon_supported() = cfg!(unix)` (`discovery.rs:22-24`), the daemon subprocess entry hard-`exit(1)`s
on Windows (`launch.rs:18-24`), and `TerminalBackend` never builds a client there
(`backend.rs:47-48` `#[cfg(unix)]`) — so Windows uses the in-process registry + read-only restore.
Parity = mirror the Unix daemon on Windows:
  - **Detach:** spawn the daemon with **`CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`**
    (`std::os::windows::process::CommandExt::creation_flags` — **std, no dep**), the Windows analog
    of `setsid()` (`discovery.rs:135-140`), so the daemon + its ConPTY children survive the app
    closing its console.
  - **IPC:** a **named pipe** `\\.\pipe\nightcore-pty-<hash>` mirroring the Unix-socket **protocol
    verbatim** (`protocol.rs` frames are transport-agnostic: control-JSON + binary-output, length-
    prefixed). `std` has **no named-pipe API**, and the Unix path is **std blocking + `std::thread`**
    (not tokio). Two sanctioned transports — **state the choice in the PR**:
    - **(recommended) raw Win32 named-pipe FFI** (`CreateNamedPipe` / `ConnectNamedPipe` /
      `CreateFile`, message-mode, blocking, one thread per client) — mirrors the Unix `std::thread`
      model exactly and adds **no dependency**, consistent with the daemon's existing `extern "C"`
      posture. More `unsafe` to write.
    - **(alternative) the `interprocess` crate** for the **Windows pipe only** (cross-platform local
      sockets) — far less `unsafe`, but a **new dependency** (lockfile + 审/audit review). Do NOT
      rip out the working Unix `std` socket to unify — scope the crate to Windows if chosen.
    - Reject tokio named-pipes: the daemon is synchronous `std::thread`; mixing an async runtime in
      is churn with no payoff.
  - **Windows auth:** the named pipe carries a **`SECURITY_ATTRIBUTES` DACL restricting to the
    current-user SID** (the Windows analog of 0600 + the D.1 peer-cred uid check) — no network, owner-
    only.
  - **`daemon_supported()` becomes `true` on Windows** only once the pipe path exists; until then it
    stays `false` and Windows keeps read-only-restore (the shipped behavior — the degradation floor).

**Degradation invariants preserved (both halves).** `TerminalBackend` already routes every op to the
local `TerminalRegistry` when the daemon is disabled / unsupported / unreachable
(`ensure_daemon` → `None` `backend.rs:225-242`; `connect_or_spawn` → `None` `:260-278`); confined
sessions are always daemon-exempt (`backend.rs:85-92`, `server.rs` forces `confined:false`
`:164-169`); scrollback is still flushed to `.nightcore/terminals/<id>.json` on cadence. **Windows
parity must honor all of these** — a dead/absent/version-skewed Windows daemon degrades to read-only
restore exactly like Unix, and confined tabs never join the daemon.

**Gate battery (PR D):** `cargo fmt --all --check` + `cargo clippy --all-targets` (green on
**Linux AND macOS AND Windows** — the peer-cred FFI is per-OS, § 9c) + `cargo test` from src-tauri
(peer-cred accept/reject unit tests with a wrong-uid stub; Windows pipe protocol round-trip behind
`#[cfg(windows)]`); `dogfood:engine` on **macOS/Linux** (enable the daemon → live shell survives a
relaunch → reattaches; a stray connection from a different uid is refused) and, if the Windows half
lands, on **Windows** (relaunch reattaches; daemon-off → read-only restore).

---

## 4. Cross-cutting: the title-source precedence (PR A) is the one new invariant

The single behavioral rule threaded through PR A: **a title write lands only if it out-ranks or ties
the current source, and Manual/Task always win.** Ranks `Manual > Task > Auto > Unset`. Concretely:
- manual inline rename (`useInlineRename` → `terminal_set_title(..., Manual)`) always writes + locks;
- `injectTask` auto-take (`terminal-tasks.ts:116` → `Task`) writes unless already `Manual`;
- AI (`terminal_suggest_title` → `Auto`) writes **only** when the effective source is `Auto`/`Unset`
  **and** (legacy-safety) the title isn't a pre-existing untracked non-empty string (treated as
  Manual).
The guard is enforced **server-side under the registry lock** so no web race can let an `Auto` write
slip past a `Manual`/`Task` rename that landed during the ~2s haiku generation.

---

## 5. PR D mini-design: Windows daemon parity + peer-cred (the risk surface)

**Goal:** the shipped Unix "live-PTY survival" daemon reaches Windows, and both platforms verify the
connecting peer is the owning user — **without** weakening the "always degrades to read-only restore"
floor.

### 5.1 What is reused unchanged
- **`protocol.rs`** frames (control-JSON + binary-output, length-prefixed) are transport-agnostic —
  the named pipe carries the identical bytes the Unix socket does.
- **`Server` + `TerminalRegistry`** (`server.rs:35-48`) — the daemon hosts the same PTY machinery in
  a process that outlives the window; Windows reuses it verbatim behind `#[cfg(windows)]` transport.
- **`fanout.rs`** replay (`REPLAY_BUDGET_BYTES = 1 MiB`) — reattach replay is platform-agnostic.
- **`backend.rs`** routing + fallbacks — the client abstraction gets a Windows arm; every `None`
  fallback to `self.local.*` stays.

### 5.2 What is new (and its risk)
| Item | Risk | Mitigation |
|---|---|---|
| Win32 named-pipe FFI (or `interprocess` dep) | Hand-rolled `unsafe` / a new dep | One thread/client mirrors the Unix `std::thread` model; if FFI is too costly, scope `interprocess` to Windows only + flag the审 review. |
| `DETACHED_PROCESS` spawn | ConPTY children torn down with the console | `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` (std `creation_flags`), stdio redirected — mirrors `setsid` detach. |
| Peer-cred FFI per-OS (`SO_PEERCRED` vs `getpeereid`) | Linux clippy reds on macOS-only code & vice-versa | `#[cfg(target_os = …)]` per branch + `#[cfg_attr(…, allow(dead_code))]` (§ 9c); unit-test the reject path with a stubbed uid. |
| New dep (`libc`/`interprocess`) | Lockfile churn + audit review | Prefer the **no-dep `extern "C"` extension** (peer-cred) and **Win32 FFI** (pipe); if a dep is unavoidable pick the **smaller** (`libc`, not `nix`) and note it in the PR body + `.cargo/audit.toml`. |
| Windows daemon dead/skewed | A broken daemon blocks the terminal | Same `hello`-version-negotiate + liveness as Unix; on any failure → read-only restore (`backend.rs` fallbacks). The floor is the shipped behavior. |
| Peer-cred false-negative locks out the owner | Legit owner connection refused | Compare against `euid()` only; on any getsockopt error, **fail-closed to refuse** ONLY the daemon connection (the app still degrades to in-process local) — never crash. |

### 5.3 Honest v1 cut
If the Windows pipe proves too heavy for this PR, ship **D.1 (peer-cred) alone** + keep Windows on
read-only-restore (unchanged) — a clean, valuable, low-risk landing. The Windows parity then becomes
its own follow-up. State whichever shape ships in the PR body.

---

## 6. Contract / persistence evolution (serde-additive, all PRs)

| Change | File | PR | Note |
|---|---|---|---|
| `terminal_ai_naming: bool` | `store/settings/model.rs` (+ `patch.rs`, `Default`, merge) | A | `#[serde(default)]`, **default false**; mirror `terminal_webgl_enabled`; regen `Settings.ts`. |
| `title_source` on live descriptor | `terminal/types.rs` `TerminalSessionInfo` (+ `PersistedTerminalInfo`) | A | camelCase TS union `"manual"|"task"|"auto"`, `Option` on the wire; ts-rs regen. |
| `title_source` on persisted record | `terminal/persist.rs` `PersistedScrollback` | A | `#[serde(default)]`, **no `v` bump** (additive); legacy → `None` (treated as Manual-if-title-present, § A.2). |
| `terminal_set_title` gains `source` | `commands/terminal.rs` (+ `PtySession`) | A | guarded write under the registry lock; `terminal_suggest_title` command added. |
| `suggestTerminalTitle` bridge | `lib/bridge/commands/terminal.ts` | A | dynamic Tauri import; degrades to `null` off-webview. |
| `writeToTargets` fan-out | `terminal-session-manager.ts` (+ keymap route) | B | no contract change; web-only. |
| `shellEscapePath` (if none exported) | `terminal-shared.ts` | C | POSIX single-quote escaping; reuse the claude-launch cwd escaper if exported. |
| Peer-cred FFI (`getpeereid`/`SO_PEERCRED`) | `terminal/daemon/discovery.rs` or `server.rs` | D | extend the existing `extern "C"` block; **no dep** (or `libc`). |
| Windows named-pipe transport + `DETACHED_PROCESS` | `terminal/daemon/*` (new `#[cfg(windows)]` arm) | D | mirror the Unix protocol; DACL owner-only; `daemon_supported()` → true only when present. |

**No new event-system (`nc:*`) channels.** Terminal traffic rides the binary `ipc::Channel` (and the
daemon protocol); the AI-naming trigger is a plain command. An event-system need is a **deviation to
flag, not silently add** (predecessor hard rule).

---

## 7. Codegen / lint lockstep checklist

| Concern | File | PR | Action |
|---|---|---|---|
| ts-rs export of `Settings` (new flag) | `store/settings/model.rs` | A | `cargo test` from src-tauri regenerates `Settings.ts`; commit. |
| ts-rs export of `TerminalSessionInfo` (`title_source`) | `terminal/types.rs` (+ `bindings/export.rs` if not listed) | A | `cargo test` regenerates `TerminalSessionInfo.ts`; commit. Never hand-edit. |
| New commands registered | `lib.rs` `generate_handler!` | A | `terminal_suggest_title` (+ any `terminal_set_title` signature change); a command absent from `generate_handler!` is invisible at runtime. |
| Web folder-per-component | `packages/eslint-plugin/` | A–C | Any new component (AI-naming Settings row, broadcast toggle/indicator, drop-hint overlay) satisfies `component-folder-structure` / thin-shell / hook-budget / ≤400-line ratchet; `no-cross-feature-imports` (terminal lives under `components/terminal/`). Validate `bun run lint`. |
| No new `nightcore/*` ESLint rule | `tools/lint-meta/`, `agent-contract-parity` | — | **Add none** (AGENTS.md-parity trap). Validate `bun run lint:meta` = zero on a clean tree. |
| New Rust dep (PR D only, if taken) | `apps/desktop/src-tauri/Cargo.toml` + `Cargo.lock` + `.cargo/audit.toml` | D | Commit the lockfile delta; the smaller of `libc`/`nix` (prefer **no-dep FFI**); note the audit/审 review. |

---

## 8. Verification gate battery (run per PR, from repo root unless noted)

```
bun run lint && bun run lint:meta                 # eslint-plugin (folder-per-component) + parity/codegen-drift
bun run --filter @nightcore/web typecheck         # root tsc -b does NOT typecheck apps/web
bun run --filter @nightcore/web test              # web unit/story tests (test:node in CI)
cargo fmt --all --check                           # MUST run from apps/desktop/src-tauri (root has no Cargo.toml → silent no-op)
cargo clippy --all-targets                        # from src-tauri; green on macOS AND Linux AND (PR D) Windows
cargo test                                        # from src-tauri; regenerates + must-commit ts-rs (Settings/TerminalSessionInfo)
bun run dogfood:ui                                # PR B/C manual: broadcast fan-out+indicator; drag file → escaped path
bun run dogfood:engine                            # PR A/D manual: AI naming (real claude haiku); daemon peer-cred + Windows reattach
```

Per-PR emphasis:
- **PR A** runs `cargo test` for real ts-rs regen (Settings + `title_source`); verify naming against
  a **real** `claude` (`dogfood:engine`) — the one-shot spawns the user's CLI.
- **PR D** must be clippy-green on **all three OSes** (per-OS peer-cred FFI, § 9c) and exercise the
  daemon-dead → read-only-restore fallback + a wrong-uid connection refusal.

---

## 9. Traps (mandatory — repo canon + round-2-specific)

**Repo canon**

**(a) Worktree bootstrap order.** A fresh worktree needs `bun install` (inherited `node_modules`
symlinks point at MAIN's packages), then `bun run --filter @nightcore/sidecar compile` before any
desktop `cargo` build (the sidecar is an `externalBin`); contract types generate BOTH ways
(zod→Rust `generated.rs`; Rust→TS `apps/web/src/lib/generated/` via ts-rs on `cargo test`). Root
`tsc -b` does **not** typecheck `apps/web` — use `--filter @nightcore/web typecheck`.

**(b) `cargo fmt`/`test` run from `apps/desktop/src-tauri`.** The repo root has no `Cargo.toml`;
from root they **silently no-op**. Always `cd apps/desktop/src-tauri`.

**(c) `#[cfg_attr(not(target_os = …), allow(dead_code))]` for platform-uneven code.** CI's
`rust-checks` job runs Linux `clippy -D warnings`; a macOS-only fn (peer-cred `getpeereid`) or a
Windows-only fn (named-pipe, `DETACHED_PROCESS`) is "never constructed" on the other OSes and reds
the gate. Annotate exactly where it bites (the daemon's existing `#[cfg(unix)]` gating is the
established pattern). Build MUST be green on all three OSes — especially PR D.

**(d) ts-rs is regenerate-and-diff.** New/changed contract fields (`title_source`, the new
`Settings` flag) export only during `cargo test` from src-tauri; register in `bindings/export.rs` if
not already, run `cargo test`, and **commit** `apps/web/src/lib/generated/*` + `bindings/*`. A missing
regen reds the CI drift guard.

**(e) `test:node` is a gate.** Web tests run under the node/vitest CI job (`bun run --filter
@nightcore/web test`); the broadcast + drag-drop + AI-naming-trigger logic must have story/unit
coverage that passes there (the dynamic-Tauri-import shape below keeps the browser dep-optimizer
from breaking mid-run).

**(f) Dynamic Tauri imports in web bridge code.** `lib/bridge/commands/terminal.ts` imports
`@tauri-apps/api/core` via **dynamic import inside `isTauri()` branches**, never top-level (kept the
vitest browser dep-optimizer from re-bundling mid-run and 404-ing in-flight module URLs). New
wrappers (`suggestTerminalTitle`, the `onDragDropEvent` registration via `getCurrentWebview`) follow
the same shape; outside the webview they degrade to a no-op/echo.

**(g) folder-per-component + ≤400-line ratchet + eslint plugin.** Every new component is a `Name/`
folder (`Name.tsx` thin shell + `.hooks.ts` + `.types.ts` + `.stories.tsx` + `.test.tsx` +
`index.ts`), ≤400 lines, no state in the body, no cross-feature imports. `bun run lint` catches
these; typecheck/tests don't.

**(h) PR labels mandatory at open.** Every PR needs a **`type:`** label and one or more **`area:`**
labels at open time. Round-2 PRs: `type: feature`, `area: terminal` (+ `area: settings` for PR A,
`area: rust` for PR D, `area: web` as applicable).

**(i) No AI / co-author attribution in commits or PRs.** Repo convention: small conventional commits
straight to `main`, **no `Co-Authored-By` / "Generated with" / AI attribution** lines (this repo
opts out). Keep messages clean.

**Round-2-specific**

**(j) `build_command` already scrubs provider env — do NOT re-add it.** `session.rs:63-70,315,322-326`
already `env_remove`s `CLAUDECODE`/`ANTHROPIC_API_KEY`/provider vars on every spawn. PR A needs zero
env work (a Claude launched *inside* an auto-named terminal already starts clean).

**(k) Title is a single `Option<String>` with NO source flag.** Manual rename, task auto-take
(`terminal-tasks.ts:116`), and AI all write the identical field via `renameSession` →
`terminal_set_title`. "Manual/task wins" is **impossible without the new `title_source` bit** (§ A.2)
— this is PR A's central design constraint, not an afterthought.

**(l) `onData` is raw keystrokes, not a clean command line.** The AI-naming capture reconstructs the
typed line from `onData` (handling backspace, ignoring control/arrow sequences) — it is **best-effort
context**, not correctness-critical. A garbled capture yields a weaker title, never an error. Do not
over-engineer a full line-editor; skiplist + debounce + a lenient capture is the scope.

**(m) `dragDropEnabled` is unset → defaults `true` → HTML5 file drop is suppressed.** Native OS file
drops are handled by Tauri (`onDragDropEvent`, absolute `paths[]`), and a webview `File` never exposes
an absolute path. **Use `onDragDropEvent`; do not switch to HTML5 `ondrop`** (it can't get the path).
`onDragDropEvent` is webview-global → hit-test the position to a pane via `data-session-id`
(§ 3.C.2).

**(n) Broadcast is a footgun — the indicator must be unmissable and auto-disarm.** Fanning keystrokes
to N shells demands a LOUD per-pane ring + badge + toggle state (§ 3.B.3) and auto-disarm on leaving
grid (§ 3.B.1). Route ALL emit paths (onData, multiline, killline, paste) through the fan-out or a
broadcast paste silently misses panes (`terminal-keymap.ts:159,162`).

**(o) The daemon is Unix-only, std-blocking, dep-free.** `terminal/daemon/` gates everything behind
`#[cfg(unix)]`, uses `std::os::unix::net` + `std::thread` (no tokio, no `interprocess`), and does
`setsid`/`geteuid` via raw `extern "C"` (`discovery.rs`). Windows parity (PR D) is **greenfield**:
`std` has no named-pipe API, so a new transport (Win32 FFI or `interprocess`) is required — mirror the
protocol, keep the std model, prefer no-dep.

**(p) Peer-cred is a deferred TODO with a real dep decision.** Only a comment exists
(`discovery.rs:12-16`). Prefer extending the existing `extern "C"` FFI (`getpeereid` /
`SO_PEERCRED`) — **no dep**. If a dep is needed pick **`libc`** (smaller) over **`nix`** (larger),
and note the lockfile + `.cargo/audit.toml`/审 review (§ 3.D.1).

**(q) Cap is 12 in two places.** `MAX_LIVE_SESSIONS = 12` (`registry.rs:26`) and
`TERMINAL_SESSION_CAP = 12` (`terminal-shared.ts:19`) — if any round-2 change touches the cap, both
move together. (No PR here changes the cap; noted so it isn't drifted accidentally.)

---

## 10. Loud flags — shipped code vs the locked decisions

1. **PR A reopens a decision the cockpit spec explicitly closed.** The predecessor's PR 5 locked
   **"Manual rename only. NO AI auto-naming in v1"**, and the shipped code still says so
   (`terminal-rename.ts:9-11` "Rename is MANUAL only (no AI auto-naming in v1)";
   `model.rs` terminal-knob comments). This round intentionally reverses that — the implementer
   should update those stale "no AI naming" comments as part of PR A.

2. **"Manual rename always wins" is NOT free — there is no title-source flag today.** Title is a
   single `Option<String>` written identically by manual rename, task auto-take (`terminal-tasks.ts:116`),
   and AI. Delivering "manual/task wins" **requires a new `title_source` field** on
   `TerminalSessionInfo` + `PersistedScrollback` + `PtySession` + a guarded write (§ A.2). Plus a
   **legacy-safety rule** (a pre-existing untracked non-empty title is treated as Manual, so AI never
   clobbers a rename made before this feature). This is the single largest PR A design item.

3. **The one-shot seam is exactly as assumed — `run_oneshot(instruction, stdin_payload) -> Option<String>`**
   (`workflow/oneshot.rs:60`, `pub(crate)`), `--model haiku`, all-tools-disallowed, 30s timeout,
   best-effort → `None`, with `strip_code_fence`/`cap` sanitizers. **Arg-order caveat
   (oneshot.rs:151-156):** the positional prompt already precedes the variadic `--disallowed-tools` —
   `run_oneshot` handles this; do not reorder. No blocker; PR A wraps it directly.

4. **`dragDropEnabled` is unset (defaults Tauri-v2 `true`) — the config shapes PR C.** With the
   default, HTML5 file `ondrop` is suppressed and a webview `File` has no absolute path, so PR C
   **must** use `getCurrentWebview().onDragDropEvent` (native, gives absolute `paths[]` + position)
   and **keep `dragDropEnabled` at the default** (no `tauri.conf.json` change). There is **no existing
   native file-drop handling** anywhere (only `ImageDropzone`'s HTML5 image handler, which is
   unrelated). Not a blocker — a plumbing choice to state in the PR.

5. **`env_remove` is already done — PR A/round-2 needs no env-hygiene work** (`session.rs:315,322-326`).
   (Contrast with the cockpit spec, where env scrub was net-new; it has since shipped.)

6. **The daemon is Unix-only with no peer-cred and no `libc`/`nix` dep — PR D is greenfield on both
   axes.** Windows is a hard `exit(1)` in the daemon entry (`launch.rs:18-24`) and uses read-only
   restore; peer-cred is a TODO comment (`discovery.rs:12-16`). Both are net-new. The dep choice
   (no-dep FFI > `libc` > `nix`) and the Windows transport choice (Win32 FFI vs `interprocess`) are
   the two decisions to state in the PR body, each with a lockfile/审 review implication for any dep.

---

## 11. Deferred / out of v1 (named so they are not silently in-scope)

- **AI naming of anything but tabs** (windows, workspaces) — out; tabs only.
- **Command capture beyond a lenient `onData` line-reconstruction** — no full shell-line editor / no
  reading echoed output; best-effort (§ 9l).
- **Broadcast outside grid** — grid-only, auto-disarms on leaving (decision B).
- **HTML5-drop / `dragDropEnabled: false` path** — rejected (can't get absolute paths, § 10.4).
- **PowerShell-shell path composition for drag-drop** — POSIX-shell only in v1 (§ 3.C.3).
- **Ripping out the Unix `std` socket to unify transports** — no; PR D scopes the Windows pipe as a
  `#[cfg(windows)]` arm, Unix stays `std`.
- **Windows live-PTY survival if the pipe half slips** — acceptable cut: ship D.1 (peer-cred) alone,
  Windows stays on read-only-restore (§ 5.3), close the pipe in a follow-up.
- **Any `nc:*` event channel for terminal traffic** — none; rides `ipc::Channel` + the daemon
  protocol (a need is a deviation to flag, § 6).
