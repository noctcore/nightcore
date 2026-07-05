# Combined Findings: Git Command Usage Consolidation

**Date:** 2026-07-05
**Skill:** /kirei-chain
**Lenses:** refactor, arch
**Scope:** Every surface of the Nightcore monorepo that spawns or governs `git`/`gh` subprocesses (Rust core, TS engine/sidecar, web, scripts), evaluating the user's goal of abstracting them into a package under `packages/`.

## Per-Lens Reports
- **Refactor:** docs/refactor/2026-07-05-git-command-consolidation.md — file-by-file inventory, duplication clusters, ordered migration plan
- **Architecture:** docs/arch/2026-07-05-git-consolidation-placement.md — surface map (Mermaid), placement decision, coupling analysis

## Cross-Cutting Themes

### 1. The premise doesn't fit the topology (both lenses, independently verified)
The TS side (`packages/`, engine, web) spawns **zero** git/gh processes in production. ~100% of git/gh subprocess execution lives in the Rust core: 23 production `git_command` spawn sites across 14 files plus the gh seam. A `packages/` TS git package would be near-empty — or worse, force git-over-IPC that duplicates the hardened env-isolation chokepoint in a second language (a security regression). **The correct consolidation target is a Rust `crate::git` module inside `apps/desktop/src-tauri/src/`, not a `packages/` entry.** The only TS git *knowledge* is ~3 pure command-string classifiers in `packages/engine/src/policy/tool-deny-policy.ts` (governance, not execution) — too small to extract.

### 2. Bounded-runner triplicate (both lenses flag the same merge candidate)
`worktree/mod.rs:106 git_with_deadline` · `workflow/pr/gh.rs:55 run_gh_bounded` · `workflow/claude_oneshot.rs:45 run_claude_with` all re-implement the same drained-pipe + `proc::wait_with_deadline` + kill discipline. Root cause: the clean runner trio is module-private inside `worktree/mod.rs`, so ~16 sites re-roll helpers against `platform::git_command` directly.

### 3. Chokepoints must stay single (both lenses, security-critical)
- `infra/platform.rs:158 git_command` — sole production git Command builder; scrubs 11 `GIT_*` vars + exec vectors, neutralizes repo-local exec config. Every new helper must build ON it.
- The gh seam (`workflow/pr/gh.rs`) — **arch found it builds via `std_command`, NOT `git_command`, so gh's inner git runs un-scrubbed.** Possibly intentional (osxkeychain credential path) — needs a deliberate, documented decision.
- TS governance chokepoints (`workspace-confinement.ts` PreToolUse gate, `tool-deny-policy.ts`) must NOT migrate into any execution package — different axis (Rust owns git *execution*, TS owns git *governance* of the agent).

## Conflicts Between Lenses
- **Execute complexity:** refactor rates the parser/helper dedup steps as simple (kirei-build); arch rates all moves as forge-level. Resolution: not a real conflict — line-level dedup (parsers, `git_stdout` copies, read-facade routing) is simple; the module carve + gh-seam migration is forge-level. Split accordingly.
- **Crate split:** refactor defers a separate Rust crate to "only if compile isolation demands it"; arch offers a cargo-workspace `nightcore-git` crate as an optional bigger move. Aligned outcome: defer.

## Unified Priority Order
1. **Rust `crate::git` carve** — promote runner trio + pure porcelain parsers into `src/git/{run,parse}.rs`; delete the 3 verbatim `git_stdout` copies and the `current_branch` re-impl — refactor + arch
2. **gh seam env-scrubbing decision** (`std_command` vs `git_command`) — small change, needs security sign-off — arch
3. **gh orchestration dedup** — `run_gh_checked`/`run_gh_json<T>`, migrate ~13 probe→run→status→map sites, centralize `PR_*_FIELDS`; pull `worktree` + `pr/gh` into the module **together** (avoids an oscillating `git ↔ workflow` edge) — refactor + arch
4. **Guard** forbidding `Command::new("git")` outside `git_command` (test-based; precedent in the adversarial neutralizer tests) + shared test-fixture git helper for the ~30 raw test spawns — arch
5. **`git::query` read facade** for `analysis/{repo_map,injection_scan}`, `workflow/ratchet.rs`, `sidecar/insight.rs` — refactor
6. *(Optional, later)* `packages/git-policy` TS extract of the pure classifiers — only if they need independent testing/sharing — arch
7. *(Deferred)* cargo-workspace crate split — both

## Recommended Execution Strategy
Single incremental arc committed to main (this repo's workflow — no PRs), one boundary at a time, `bun run test:rust` green between every step; the numstat/left-right/porcelain parser tests and the `injection_scan` neutralizer test are the guard rails. Steps 3–4 of the refactor plan touch the `worktree ↔ workflow` seam — build after each migrated call site. Keep `claude_oneshot`'s least-privilege arg building bespoke (share only drain/deadline mechanics).

## Out of Scope (Surfaced but Not Investigated)
- The gh seam's un-scrubbed inner-git env (theme 3) borders on a security-lens question; if the decision is contentious, a focused /kirei security pass on `workflow/pr/gh.rs` would settle it.
- ~30 `Command::new("git")` sites in test fixtures (dedup cluster → shared test helper) — folded into priority 4 rather than separately investigated.
