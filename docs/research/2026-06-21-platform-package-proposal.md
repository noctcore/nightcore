# Platform-Aware Logic — Inventory & `@nightcore/platform` Boundary Proposal

**Date:** 2026-06-21
**Type:** Read-only research / boundary proposal
**Trigger:** User just fixed Windows bun-spawning (`resolve_bun_program`, `m2/provider.rs`) and wants a dedicated home for "platform-aware checks / resolutions of bun or other stuff."

---

## TL;DR

- Platform-aware logic in Nightcore is **split across two languages** and a single `packages/platform` (TS) **cannot** hold the Rust bun-spawn fix — that fix lives in the Tauri core where the sidecar is actually spawned.
- The Rust core is where the real cross-platform danger concentrates: **`std::process::Command` with bare program names** (`bun`, `npm`, `cargo`, `git`) that `CreateProcess` can't launch through npm/PATHEXT shims on Windows — the exact bug class the bun fix just patched, with **3 more unfixed instances** in `gauntlet.rs`.
- **Recommendation: (c) both, named consistently — but build the Rust side first.** A small Rust `platform` module (consolidating the `which`-aware program resolver) is worth it now because it removes real, already-proven Windows breakage. A TS `packages/platform` is **defer** — the TS platform surface is tiny (3 files, mostly trivial `os.homedir()` wrappers) and extracting it now is premature abstraction.

---

## 1. Inventory

Every platform-aware / OS-divergent site found, by tier. "Risk" = whether it can actually break across macOS↔Windows.

### Rust core (`apps/desktop/src-tauri/src/`)

| File:Line | What it does | OS special-case | Risk |
|---|---|---|---|
| `m2/provider.rs:50-76` `resolve_bun_program` | Resolves a launchable Bun program via `which::which("bun")`, falls back to `cmd /C bun` under `#[cfg(windows)]` | **Windows** (just fixed) | — (fixed) |
| `m2/provider.rs:222` | `Command::new(&bun.program).args(&bun.prefix_args).arg("run").arg(&self.entry)` — the consumer of the resolver; **hot path, every sidecar spawn** | uses resolver | — (fixed) |
| `m2/provider.rs:59`, `:67`, `:532` | `#[cfg(windows)]` / `#[cfg(not(windows))]` / `#[cfg(windows)]` (test) — the only conditional-compilation in the tree | Windows | — |
| `gauntlet.rs:205` | `Command::new(&step.program)` where `step.program` is the **bare string `"bun"` or `"npm"`** (`gauntlet.rs:97-99`) | **none — unfixed** | **HIGH** — same bug class as the bun fix; `bun`/`npm` are npm shims on Windows, `CreateProcess` can't launch them |
| `gauntlet.rs:174` | `Command::new("cargo")` (clippy probe) | none | LOW — cargo is a real `.exe` on Windows, but still a bare name |
| `gauntlet.rs:97-99` `detect_node_steps` | Picks `"bun"` vs `"npm"` by lockfile presence — produces the bare program name consumed above | none | feeds HIGH site above |
| `m2/worktree.rs:52,214,360,431,...` | `Command::new("git")` (many call sites) | none | LOW-MED — `git` is normally a real `.exe` on Windows, but bare-name + "is git on PATH?" error (`worktree.rs:56`) is the same fragile pattern |
| `project.rs:257,400` | `StdCommand::new("git")` (repo detection) | none | LOW-MED — same as above |
| `store.rs:19-21` `workspace_root` | `PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")` | none (path-sep handled by `PathBuf`) | LOW — dev-only path; relative `../../..` is OS-agnostic via `PathBuf` |
| `lib.rs:49-51` | `app.path().app_config_dir()` (Tauri) | Tauri abstracts per-OS | — (Tauri owns it) |
| `lib.rs:70` | `workspace_root().join("apps/sidecar/src/index.ts")` — forward-slash literal in `.join()` is fine (`PathBuf` normalizes) | none | LOW |
| `logging.rs:38-39` | `app.path().app_log_dir()` (Tauri) | Tauri abstracts per-OS | — (Tauri owns it) |
| `m2/worktree.rs:43-47` `is_under` | Lexical path-component comparison (no OS branch; relies on `Path::components`) | none | LOW |

### TS tiers (`packages/`, `apps/`)

| File:Line | What it does | OS special-case | Risk |
|---|---|---|---|
| `packages/shared/src/paths.ts:5-6` `nightcoreHome` | `path.join(os.homedir(), '.nightcore')` | `os.homedir()` is cross-platform | LOW (trivial wrapper) |
| `packages/shared/src/paths.ts:20-24` `expandHome` | Expands leading `~` / `~/` to `os.homedir()` | manual `~` handling (Unix convention; harmless on Windows) | LOW |
| `packages/shared/src/paths.ts:10-17` | `sessionsDir`, `projectDir` — pure `path.join` | none | LOW |
| `packages/config/src/index.ts:85-86` | `process.cwd()` default + `nightcoreHome()` | none | LOW |
| `packages/engine/src/session-runner.ts:309` | `executable: 'bun'` in SDK `Options` — tells the SDK to run its CLI under Bun | **bare `'bun'`** handed to the SDK subprocess spawner | MED — SDK spawns this; same shim risk as Rust, but **inside the sidecar** which is *already* running under Bun, so PATH/bun is known-present there |
| `packages/engine/src/resolve-claude-binary.ts:24-40` | Resolves `claude` binary path for `pathToClaudeCodeExecutable`; opt-in `execFileSync('which', ['claude'])` | bare **`which`** (Unix-only; Windows has `where`) | MED — only runs when `NIGHTCORE_USE_SYSTEM_CLAUDE` is set; silently degrades on failure |
| `apps/tui/src/commands/doctor.ts:106-114` `whichClaude` | `execFile('which', ['claude'])` diagnostic | bare **`which`** (Unix-only) | MED — `/doctor` will always report "Claude CLI not found" on Windows because `which` doesn't exist there (`where` does) |
| `apps/tui/src/commands/doctor.ts:33` | `join(homedir(), '.claude')` | cross-platform | LOW |
| `packages/eslint-plugin/src/utils/component-architecture.ts:25` | Normalizes `path.sep` + `\\` to `/` for a lint rule | handles both seps | LOW (tooling-only, not runtime) |

**Tiers with NO platform branching (confirmed by grep):** `apps/web` (renderer — zero `process.platform`/`win32`/`darwin`), `apps/sidecar/src` (pure protocol plumbing), `apps/cli`.

### Inventory headline

The platform surface is **lopsided**: the TS side is ~3 thin files of mostly-trivial home/path wrappers, while the **Rust core holds the real risk** — a *family* of bare-program-name `Command::new(...)` spawns (`bun`/`npm`/`cargo`/`git`) of which only the sidecar `bun` spawn has been hardened. The two **bare `which` invocations in TS** (`resolve-claude-binary.ts`, `doctor.ts`) are a smaller, lower-blast-radius mirror of the same "Unix tool assumed present" assumption.

---

## 2. Boundary recommendation

**Recommend (c): both — one platform home per language, named consistently — but with very different urgency and size.**

A single `packages/platform` is structurally impossible to satisfy the user's stated goal: the bun-spawn fix lives in `m2/provider.rs` because **the Rust core is the process that spawns the sidecar**. TypeScript cannot reach that spawn. Platform logic is genuinely bilingual here, so the boundary must be too.

### Rust: `apps/desktop/src-tauri/src/platform/` (a module, BUILD NOW)

A new `platform` module (sibling to `m2`, `gauntlet`, `worktree`) consolidating **process-launch resolution** — the one thing that has actually broken.

- `platform::resolve_program(name) -> ResolvedProgram { program, prefix_args }` — generalize `resolve_bun_program` (currently `m2/provider.rs:50`) into a name-parameterized resolver: `which::which(name)`, else `cmd /C <name>` under `#[cfg(windows)]`, else bare name. `resolve_bun_program()` becomes `resolve_program("bun")`.
- Keep the `BunProgram`/`ResolvedProgram` struct here.
- Consumers: `m2/provider.rs:222` (bun — unchanged behavior), and **newly** `gauntlet.rs:205` (`bun`/`npm`) — closing the unfixed HIGH-risk site.

Why a module, not a crate: it's <100 LOC, Tauri-coupled (the dir resolvers it might later absorb need `AppHandle`), and the workspace is a single binary crate. A submodule is the right grain; a separate crate is over-engineering.

### TS: `packages/platform` (DEFER — do not build yet)

If/when built, it would hold exactly two things:
- A cross-platform **`whichSync(cmd)`** that uses `where` on Windows / `which` elsewhere (or the `which` npm package), replacing the bare `execFileSync('which', ...)` in `resolve-claude-binary.ts:30` and `doctor.ts:108`.
- Re-export the `paths.ts` home/path helpers (or just leave them in `@nightcore/shared` — they already work cross-platform via `os.homedir()`).

The TS platform surface today is **too small and too benign** to justify a new package: `paths.ts` already works on Windows (`os.homedir()` is portable), and the only real TS bug (`which` on Windows) is a 2-call-site fix that doesn't need a whole package. Creating `packages/platform` now is premature abstraction — a package with one helper and a re-export.

**Naming:** if both are eventually built, mirror them: Rust `platform` module ↔ TS `@nightcore/platform`. Until the TS one earns its keep, the two `which` call sites can share a one-function helper inside `@nightcore/shared` (e.g. `paths.ts`'s neighbor `which.ts`).

---

## 3. What moves vs what stays

### Moves (into Rust `platform` module)
- `resolve_bun_program` + `BunProgram` struct (`m2/provider.rs:40-76`) → generalized `resolve_program(name)` + `ResolvedProgram`. **Behavior must be byte-identical for `"bun"`** (see §4 risk).
- The two `#[cfg(windows)]`/`#[cfg(not(windows))]` arms (`m2/provider.rs:59-73`) move with it.
- The regression tests (`m2/provider.rs:527-556`) move with it.

### Should-be-rewired-to-the-resolver (the actual payoff)
- `gauntlet.rs:205` `Command::new(&step.program)` → `Command::new(resolve_program(&step.program)...)`. **This is the main win** — it fixes an unpatched instance of the exact bug the user just chased on the sidecar.
- (Optional, lower value) `worktree.rs` + `project.rs` `git` spawns and `gauntlet.rs:174` `cargo` spawn — route through the resolver for uniform Windows-safety and a consistent "not launchable" error. `git`/`cargo` are usually real `.exe`s so this is defense-in-depth, not a known break.

### Stays (too coupled / too trivial — do NOT extract)
- **Tauri dir resolution** (`lib.rs:49 app_config_dir`, `logging.rs:38 app_log_dir`) — Tauri already abstracts per-OS; wrapping it adds nothing and needs `AppHandle`. Leave in place.
- **`store.rs:19 workspace_root`** — dev-only, `PathBuf`-based, OS-agnostic. Trivial; not platform logic.
- **`worktree.rs:43 is_under` / path joins** — `Path`/`PathBuf` already handle separators. No OS branch to consolidate.
- **TS `paths.ts`** — already cross-platform; moving it is churn. Leave in `@nightcore/shared`.
- **`session-runner.ts:309 executable: 'bun'`** — this is an SDK `Options` value, not a spawn the harness controls, and it runs *inside* the already-Bun sidecar where bun is definitionally present. Not a platform-resolution concern; leave it.

---

## 4. Migration cost, ordering, and risk

| Step | Scope | Cost | Risk |
|---|---|---|---|
| 1. Create Rust `platform` module; move + generalize `resolve_bun_program` → `resolve_program(name)`; keep `resolve_bun_program()` as a 1-line shim calling it | `m2/provider.rs` + new `platform/mod.rs` + `lib.rs` `mod platform;` | **S** | **MED — hot path.** `resolve_program("bun")` must produce the **identical** `BunProgram` the Windows fix produces, or the just-fixed spawn regresses. Mitigant: the existing tests (`m2/provider.rs:531-556`) move with it and pin the contract; add a `resolve_program("bun") == resolve_bun_program-old` equivalence assertion during the move. |
| 2. Rewire `gauntlet.rs:205` (and `:174`) through `resolve_program` | `gauntlet.rs` | **S** | LOW-MED — gauntlet is off the per-spawn sidecar hot path (runs once per task verification). Net positive: closes the HIGH-risk unfixed Windows site. |
| 3. (Optional) Rewire `git` spawns in `worktree.rs`/`project.rs` | several call sites | **M** | LOW — many call sites, mechanical; `git` rarely breaks on Windows so low payoff. Defer. |
| 4. (Defer) TS `whichSync` helper for `resolve-claude-binary.ts` + `doctor.ts` | 1 helper + 2 call sites | **S** | LOW — `doctor.ts` is diagnostic-only; `resolve-claude-binary` path is opt-in. Fix when Windows TS support is actually exercised. |
| 5. (Defer) `packages/platform` package proper | new package | **M** | N/A — only if the TS surface grows. |

**Single biggest risk:** Step 1 touches the **sidecar-spawn hot path** (`m2/provider.rs:222`, runs on every provider start). The Windows bun fix is brand-new and load-bearing. Any extraction must preserve `resolve_bun_program`'s exact output for `"bun"` and must keep `#[cfg(windows)]` gating intact. The move is mechanical and the regression tests already encode the contract — but treat behavior-preservation as the acceptance bar, not refactor cleanliness.

---

## 5. Recommended next step

**Do only the Rust module first — and scope it to the spawn resolver, not dir resolution.**

1. **Build now (S):** create `src-tauri/src/platform/` with a name-parameterized `resolve_program`, move `resolve_bun_program` + its tests into it, and **rewire `gauntlet.rs`'s `bun`/`npm` spawn through it.** This is the highest-value move: it gives the user the "dedicated place for platform-aware resolutions of bun or other stuff" they asked for *and* fixes a second live instance of the same Windows bug in one stroke.
2. **Defer the TS `packages/platform`.** Capture the two `which`-on-Windows call sites (`resolve-claude-binary.ts:30`, `doctor.ts:108`) as a known follow-up; fix them with a small shared `whichSync` helper only when TS-on-Windows is actually being run. Don't stand up a package for one function.
3. **Leave Tauri dir APIs and `paths.ts` exactly where they are** — they're already cross-platform and extracting them is churn with no defect closed.

Net: one small Rust PR closes the real remaining Windows risk and creates the boundary the user wants; the TS side stays a deliberate "not yet."
