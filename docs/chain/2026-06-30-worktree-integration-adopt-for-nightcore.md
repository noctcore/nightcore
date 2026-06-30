# Combined Findings: Worktree Integration — what to adopt for nightcore

**Date:** 2026-06-30
**Skill:** /kirei-chain
**Lenses:** arch, ui
**Scope:** Compared git-worktree integration across nightcore, automaker, and Aperant — both the backend architecture/lifecycle (arch) and the user-facing surface (ui) — to decide what nightcore should adopt.

## Per-Lens Reports
- **Architecture:** docs/arch/2026-06-30-worktree-integration-comparison.md
- **UI/UX:** docs/ui/2026-06-30-worktree-ux-comparison.md

## Verdicts at a glance

| Lens | #1 | #2 | #3 | One-line |
|---|---|---|---|---|
| **arch** | nightcore (best-factored + safest) | automaker (most capable + best git foundation) | Aperant (best safety primitives, worst-factored: 3,111-line god file) | nightcore is the cleanest leaf but the *least capable* — merge-only, no diff/conflict detail. |
| **ui** | Aperant (clarity/safety/feedback) | automaker (most powerful, but overwhelming density) | nightcore (cleanest + best a11y + best board integration, but thinnest) | nightcore's surface is elegant but a user **merges blind** — no diff, no preview, no confirmation, no stats. |

**The combined story:** nightcore has the best *bones* on both sides (cleanest Rust leaf `worktree.rs`, best board-integrated `WorktreeSwitcher`, best a11y) and the thinnest *capability* on both sides. The fix is the same on both: **keep nightcore's architecture, do NOT import the siblings' structure/density — selectively graft capability.** automaker is the donor for the git foundation + create flow + deep diff; Aperant is the donor for safety primitives + merge/review/discard UX.

## Cross-Cutting Themes (highest-leverage — appeared in BOTH lenses)

1. **"Merge blind" is the same gap seen from two sides — and one backend capability fixes both.**
   - arch: nightcore treats *any* merge failure as `Conflict` and reports no file list (`apps/desktop/src-tauri/src/worktree.rs:237-242`); there is no diff/stat extraction anywhere.
   - ui: no diff view, no merge preview, no confirmation, no file/line stats; the user fires Merge with zero information (`apps/web/src/components/board/TaskDetail/TaskDetail.tsx:253-296`); `bridge.ts:531-581` exposes only `listWorktrees`/`mergeTask`/`commit`.
   - **Leverage:** a single new backend capability — **diff/stat extraction + conflict pre-detection** — simultaneously delivers arch's conflict-detection robustness AND ui's merge-preview / changed-files / progress surfaces. This is the keystone of the whole effort.

2. **Both lenses independently rank nightcore "best structure, thinnest capability."** arch: best-factored leaf (~430 LOC, unit-tested path math, lease concurrency, panic-tolerant status, boot reconcile) but merge-only. ui: cleanest + best a11y + best board integration, but missing the core review/merge affordances. Same prescription: preserve, then extend.

3. **Adopt selectively; reject both siblings' structure.** arch: avoid Aperant's 3,111-line `worktree-handlers.ts` god file and automaker's ~50-route sprawl. ui: do NOT import automaker's density (1,654-line panel / 1,463-line dropdown). Both name Aperant for *quality of merge/review/discard* and automaker for *git foundation + create flow + deep diff*.

4. **Conflict handling is the shared weak point.** arch: detection is coarse (`LC_ALL=C` + `diff --diff-filter=U` + porcelain parsing not yet present). ui: conflicts aren't surfaced and there's no resolution affordance. Both point at the same coupled automaker feature (3-layer conflict detection backing an AI-vs-manual resolution choice).

## Conflicts Between Lenses

1. **AI / intent-aware conflict resolution — adopt vs. resist.**
   - ui (pattern #9) wants automaker's AI-vs-manual conflict-resolution *choice* surfaced when a merge conflicts (`merge-worktree-dialog.tsx:186-269`).
   - arch explicitly cautions AGAINST Aperant-style AI intent-aware merge as a *default* — "keep abort-not-force as the default; AI merge at most an opt-in Tier-3 path."
   - **Resolution (not contradictory):** on conflict, *surface a resolution choice* (ui's ask) but keep the *default* safe — abort, never auto-AI-merge (arch's ask). AI resolution ships opt-in only, behind its own design pass. Both are satisfied.

2. **Always-show worktree status vs. minimalism (mild).**
   - ui (pattern #5) wants to relax `WorktreeSwitcher.tsx:14`'s `tabs.length <= 1` early-return so status is always visible.
   - arch praises nightcore's minimalism but is scoped to *backend* factoring, not UI visibility — so this is a UI-only call, not a real architectural conflict. Recommend: adopt ui's always-show with an optional per-project visibility toggle (automaker `board-header.tsx:199-216`).

## Unified Priority Order (ranked across BOTH lenses)

1. **[KEYSTONE / cross-cutting blocker] Backend diff+stat extraction & conflict pre-detection** — new engine/Rust capability + contract. Unlocks arch conflict-detection AND ui preview/changed-files/progress. — *arch + ui*
2. **Git-env isolation before every git spawn** — clear `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY`/`GIT_AUTHOR_*`/`GIT_COMMITTER_*` (+`HUSKY=0`); confirmed gap at `infra/platform.rs:78-113`. Small, low-risk, pure backend, independent of #1. — *arch (Aperant `git-isolation.ts:30-80`)*
3. **Merge-preview panel + changed-files view** (ready / N-conflicts / diverged + file list + ±counts) — depends on #1. — *ui (Aperant `MergePreviewSummary.tsx`, `DiffViewDialog.tsx`)*
4. **Locale-stable multi-layer conflict detection + `conflictFiles` list** — `LC_ALL=C` + `diff --diff-filter=U` + porcelain unmerged parsing; replaces the coarse "any failure = Conflict" at `worktree.rs:237-242`. Part of #1's backend slice. — *arch (automaker `merge-service.ts:136-226`)*
5. **Robust cross-platform cleanup (retry + fallback) + safe discard/cleanup confirmation UI** (stats + consequence + error->retry) — paired backend+frontend. — *arch (Aperant `worktree-cleanup.ts:106-145`) + ui (Aperant `DiscardDialog.tsx`, `WorktreeCleanupDialog.tsx`)*
6. **Always-show worktree status + richer inline badges** (dirty file-count, behind-count, conflict count + tooltip) — cheap, frontend-only. — *ui (`WorktreeSwitcher.tsx:14`, automaker `worktree-tab.tsx:349-394`)*
7. **Base-branch fetch + fast-forward sync before create** (nightcore branches off stale local HEAD at `worktree.rs:96-109`) — backend, medium risk. — *arch (automaker `create.ts:201-245`)*
8. **Merge-progress overlay (with stall detection) + friendly git-error->human-copy toasts** — needs merge-progress events from #1's backend. — *ui (Aperant `MergeProgressOverlay.tsx`, automaker `create-worktree-dialog.tsx`)*
9. **Small hardening:** `update-index --refresh` before status reads (`worktree.rs:338`); exact-match branch verify before destructive ops (`delete_branch` `worktree.rs:266-272`). — *arch (Aperant `git-isolation.ts:207-218,148-183`)*

## Recommended Execution Strategy

**Stagger, do not bundle.** Three workstreams:

- **A — Safety hardening (independent, ship first/parallel):** priorities #2, #9, and the cleanup half of #5. Small, low-risk, pure `worktree.rs` + a new `infra/platform.rs::git_command`. arch's hard constraint: **one pattern at a time, `cargo test` after each** (the existing worktree tests are a strong safety net).
- **B — The keystone capability (gates the UI work):** priorities #1 + #4 + #7 as a focused cross-tier slice (contracts -> engine -> Rust -> web). This is the dependency for everything visual.
- **C — UI layer (depends on B):** priorities #3, #5(UI), #6, #8 — folder-per-component work, kirei-forge. Run impeccable:harden (empty/loading/error for new diff/preview surfaces), impeccable:clarify (merge-preview/discard/conflict copy), impeccable:polish (badge consistency) during implementation.

**Complexity:** both lenses say **kirei-forge** — worktree/merge changes are never simple and these are cross-tier. Preserve nightcore's wins explicitly: leaf module + unit-tested path math, `is_under` removal guard, dirty-base refusal, abort-not-force default, panic-tolerant status, `SlotManager`+single-flight lease, boot reconcile; on the UI side worktree-as-board-filter tabs, roving-tabindex a11y, debounced live refetch.

## Out of Scope (surfaced but not investigated)

- **AI intent-aware merge engine** (Aperant) — flagged by both lenses; recommended *only* as an opt-in Tier-3 path behind its own design pass. Needs a dedicated /kirei-discuss before any build.
- **Worktree metadata sidecar (PR/init/createdAt)** (arch #7, automaker `worktree-metadata.ts`) — only relevant if a PR flow lands. nightcore's workflow is commit-to-main / no-PRs, so likely out of scope today.
- **automaker's extra per-worktree surfaces** — dev-server logs, stash list, PR dialogs (ui noted, not investigated). Candidate for a future /kirei-chain if nightcore grows those features.
