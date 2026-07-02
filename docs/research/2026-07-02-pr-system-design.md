# The Pull Request System — full-arc design

**Date:** 2026-07-02
**Status:** DESIGN — phase 1 not yet built
**Reference implementation studied:** Auto-Claude (`AndyMik90/Auto-Claude`, Electron+React) — its local task-review + `gh pr create` escape hatch, and its separate multi-agent GitHub PR reviewer.

---

## 1. Why now, and what it is

The control-panel roadmap (2026-06-26) locks pipeline skills (`commit → open-pr → release`) as the next phase after core, and flags the gap explicitly: *the terminal action today is only a LOCAL merge — there is no `git push`/`gh`/PR path anywhere.* That is still true (verified 2026-07-02: zero push/fetch/`gh` usage in `src-tauri/src/`; the only remote awareness is the read-only `refs/remotes` scan in `worktree/branch.rs:170-189`).

The PR arc completes the task lifecycle story:

| Stage | Today | With the PR arc |
|---|---|---|
| Finish | commit (AI message) / local merge | unchanged |
| Publish | — | **push branch + create PR** (phase 1) |
| Track | — | **PR status: checks, reviews, mergeable** (phase 2) |
| Respond | — | **address review comments via a fix run** (phase 3) |
| Review | internal reviewer only | **AI PR reviewer scan → post a real GitHub review** (phase 4) |

## 2. Principles (apply to every phase)

1. **Deterministic plumbing in Rust; agent work in sessions.** Push, PR create, status polls, comment fetches = Rust shelling to `git`/`gh` — no agent, no nondeterminism. Address-comments and the AI reviewer = sidecar agent sessions, because they are judgment work.
2. **`gh` CLI is the GitHub seam.** User-installed, `which`-probed, never bundled — the exact precedent of the `claude` binary and the gitleaks gate. `gh` owns auth (keychain-backed); Nightcore stores **no tokens**. Absent `gh` ⇒ the feature is invisible/disabled, not broken.
3. **Every outward action is human-gated.** Push, PR create, review post, thread replies: always behind a ConfirmDialog showing exactly what leaves the machine (remote, branch, base, title/body). Never auto-fired, never agent-fired. This is a hard rule — publishing is irreversible in a way local merges are not.
4. **GitHub-derived text is untrusted input.** PR comments, review bodies, and PR descriptions can be written by *anyone*. Everything inbound that reaches a prompt goes through `untrusted_block` (`sidecar/scan.rs:151`); any inbound text minted into a title goes through `sanitize_minted_title` (`store/task/model.rs:448`). This is the same posture as scan findings, and it is where the deny/ask policy tiers + Seatbelt sandbox earn their keep.
5. **Model-derived outbound text is human-editable before it posts.** AI-drafted PR titles/bodies/review summaries are pre-filled into an editable dialog, not posted directly. The `claude -p` drafting pass keeps the all-tools-disallowed posture of `commit_msg.rs` (least-privilege note at `commit_msg.rs:14-22`).
6. **Serde-additive, no new TaskStatus.** PR state hangs off the task as optional fields (like `committed`/`merged` flags), not a new status variant. Auto-Claude's `pr_created` status is a lesson in what to avoid — a status fork multiplies every board/loop match arm; a field does not.

## 3. Phase 1 — Create PR (the slice to build first)

Auto-Claude's shape, adapted: a **Create PR** terminal action beside Merge on a committed worktree task.

### 3.1 Backend — new `workflow/pr.rs`

**Probe + capability surface.** Clone the `secret_scan.rs` template (`scan_staged_with`, `secret_scan.rs:52-110`):

- `gh_probe()` — `which::which("gh")`; absent ⇒ capability off.
- `remote_url(repo)` — new read-only helper in `worktree/` (`git remote get-url origin` via the `git()` chokepoint, `worktree/mod.rs:83-93`). No remote ⇒ capability off.
- One small command `pr_support(id) -> PrSupport { gh_installed, remote: Option<String> }` (ts-rs exported) so the UI can gate the button honestly instead of failing on click.

**`create_pr_task(app, id, opts)`** — async `#[tauri::command]` + `spawn_blocking` (the WKWebView threading rule), single-flight via a new `pr_in_flight()` `TaskLease` set (pattern: `merge.rs:100-135`). Blocking body, in order:

1. Lease; load task + project (`require_project`, `merge.rs:23-27`).
2. **Preconditions:** worktree mode (`refuse_main_mode_merge` twin — main-mode tasks have no branch to push); `task.committed` (worktree tasks are pre-review checkpointed, so normally true); `task.verified` — *same bar as merge*. A PR is a publish; it must not be a side door around the gauntlet.
3. **Gauntlet:** run `gauntlet::run(&worktree_dir)` + `gauntlet_project::run` exactly as `merge_task_blocking` does (`merge.rs:235-253`). Same gates, same park behavior.
4. Resolve `branch`/`base` like merge does (`merge.rs:256-263`), both through `validate_ref` (`worktree/path.rs:50-91`) — refs are the injection surface of git argv.
5. **Push:** `git push -u origin <branch>` from the worktree dir via the `git()` chokepoint. Plain push only — no `--force`, ever (the abort-not-force philosophy extends to the remote).
6. **Create:** `gh pr create --head <branch> --base <base> --title <t> --body-file - [--draft]`, body on **stdin** (never argv — length + injection). Spawn via `crate::platform::std_command("gh")` with cwd = worktree. Parse the PR URL from stdout; derive the number.
7. Persist: `store.mutate(id, |t| { t.pr_url = Some(url); t.pr_number = Some(n); })`, emit `TASK_EVENT`. Failure between push and create is safe — re-running re-pushes (idempotent) and retries create; `gh` itself errors if a PR already exists for the branch, which we surface verbatim.

**Task model (serde-additive):** `pr_url: Option<String>`, `pr_number: Option<u64>` on `Task` (`store/task/model.rs`, `#[serde(default)]` + `ts(optional)`, legacy-JSON round-trip test like `model.rs:584-605`); ts-rs regen via `cargo test`. Not patchable via `TaskPatch` — only the create/status paths write them.

**AI title/body drafting.** Extract the reusable core of `commit_msg.rs::run_claude` (`commit_msg.rs:107-191` — arg-order gotcha, stdin feed, 30s timeout, sanitize) into a shared one-shot helper; add `pr_msg::draft_for(store, dir, task, base) -> Option<(String, String)>`:

- Payload: task title/description + `git diff <base>...<branch>` (capped like the 12k diff cap) + transcript digest.
- Instruction: produce `Title` line + markdown body (Summary / Test plan), conventional-commit-style title.
- Fallback: task title + `task.prompt()` body. Drafting runs when the dialog opens (a separate `draft_pr_message(id)` command), so the create command itself never blocks on `claude`.
- Sanitize output (`commit_msg.rs:196-216` twin) — and it is *pre-filled, editable, confirmed* per principle 5.

### 3.2 Frontend

- **TaskDetail footer** (`TaskDetail.tsx:337-380`): on a committed, verified, worktree-mode task with `pr_support` green — show **Create PR** beside Merge. After creation: a `PR #123 ↗` chip (opens in browser) replaces the button; Merge stays available (you can still finish locally — see phase 2 for the remote-merged path).
- **`CreatePRDialog/`** — folder-per-component sibling of `MergePreviewDialog/`: base picker (reuse `listBranches` bridge, `bridge.ts:626`), draft toggle, editable title + body pre-filled by `draftPrMessage`, and a confirm footer that states verbatim: *push `<branch>` → `origin`, open PR against `<base>`*. Mutually-exclusive-dialog rule from `WorktreeView.hooks.ts:152-160` applies.
- **WorktreeManager rows** (`WorktreeManager.tsx:12-57`): PR chip when `pr_url` is set.
- Bridge: `createPrTask`, `draftPrMessage`, `prSupport` wrappers + `action.guard` wiring in `AppShell.hooks.ts` (pattern: `handleMerge`, `:459-468`). No new event channel needed — `TASK_EVENT` already carries the updated task.

**Worktree lifecycle interaction:** `cleanup_worktrees` only fires on *local* merge (`merge.rs:268-274`), so a PR'd worktree persists until the PR resolves — correct by construction. Phase 2 adds the remote-merged finalize.

**Estimated size:** one focused session (same order as auto-commit-on-verified).

## 4. Phase 2 — PR status tracking

**Backend:** `pr_status(id) -> PrStatus` — `gh pr view <n> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,baseRefName,headRefOid,url` from the worktree dir, deserialized into a ts-rs-exported `PrStatus` struct. On-demand only (refresh button + fetch-on-open); **no background polling daemon** in this phase — a poll loop is a battery/rate-limit tax the on-demand model doesn't pay.

**Frontend:** a `PrStatusCard` in TaskDetail (below `GauntletResults`): checks rollup (pass/fail/pending counts), review decision, mergeable/behind, draft badge. Same card summarized as a badge on WorktreeManager rows.

**Remote-merged finalize:** when `state == MERGED` — offer **Finalize** (human-gated): set `t.merged = true`, honor `cleanup_worktrees` (worktree remove + `delete_branch_named`), and offer a fast-forward-only pull of the base on the project root (`git pull --ff-only`, refuse otherwise). This closes the loop Auto-Claude leaves dangling (task says `pr_created` forever).

**Push updates:** the phase-1 push is already re-runnable; expose it as **Push updates** on a task whose PR is open and whose worktree is ahead (`WorktreeStatus.ahead_of_base` twin computed vs the remote ref). Behind-base ⇒ report it; do **not** auto-rebase (abort-not-force).

## 5. Phase 3 — Address review comments

**Fetch:** `list_pr_comments(id) -> Vec<PrThread>` — `gh api` GraphQL for **unresolved review threads** (path, line, author, body, thread id) + top-level review summaries. Typed via ts-rs; rendered as a read-only **Review comments** section in TaskDetail.

**The loop — re-dispatch, not a new task.** Auto-Claude's reject path (feedback file → same agent, same worktree, loop until re-review) maps onto machinery Nightcore already has: the reviewer/fix dispatch. `address_pr_comments(id)`:

1. Build a fix prompt: each comment body wrapped in `untrusted_block`, with author/path/line as trusted metadata *outside* the fence. (Anyone can comment on a public PR — this is the highest-injection-risk text in the whole arc; the workspace-confinement + policy + ask tiers all still gate the session.)
2. Dispatch a fix run on the task's **existing worktree/branch** (the `rerun_verification` shape: lease slot, `ensure_reader`, flip to in-progress, dispatch — `merge.rs:375-425`), flowing into the normal verify → gauntlet path.
3. On verified: the phase-2 **Push updates** button publishes the fixes (human-gated, as always).

**Explicitly deferred within phase 3:** posting replies / resolving threads from Nightcore. v1 leaves thread resolution to the GitHub UI; a later 3.5 can add human-gated batch replies via `gh api`. (The `address-pr-comments` *skill* does this agent-side; if the TaskKind→skill-registry keystone lands first, this phase can shrink to dispatching that skill with the fenced context.)

**No new TaskKind needed** — the fix-run identity covers it. If a distinct kind proves useful later, the recipe is known (`model.rs:55-79` + `kind.rs:29-55` + `kind-presets.ts` + two codegens).

## 6. Phase 4 — AI PR reviewer (the scan sibling)

Auto-Claude's strongest idea, rebuilt on the scan platform: a fourth scan feature, **PR Review**, alongside Insight/Scorecard/Harness.

- **Sidecar:** a new `ScanManager` subclass (`scan-manager.ts:188-531`) — items = review lenses (security / logic / structure / tests / contracts), context = `gh pr diff` + changed files, sessions read-only. For reviewing *foreign* PRs: `gh pr checkout` into an **isolated temp worktree** with the Seatbelt sandbox on (module #15) — a hostile PR head is untrusted code and must never execute in the project root.
- **Validation pass:** a finding-validator stage (Auto-Claude's `cross-validation` → our adversarial-verify pattern) to kill false positives before a human sees them.
- **Rust:** one `scan_kinds!` entry (`run_store.rs:303-315`) + reader handlers + lifecycle commands via `scan_lifecycle_commands!` (`sidecar/scan.rs:55-99`).
- **Web:** drops into `RunLifecycleShell` unchanged; Results = severity-grouped findings with checkboxes (the ReviewFindings shape).
- **Terminal action (human-gated):** post selected findings as a real GitHub review — `gh pr review --approve|--request-changes|--comment --body-file -` + inline comments via `gh api` batch. Findings also reuse `convert_to_task` (`sidecar/convert.rs:38-84`) for a "fix locally" path.

This is the largest phase (a full feature clone); it should not start until phases 1–2 are dogfooded.

## 7. Cross-cutting decisions

- **argv hygiene:** every ref through `validate_ref`; every body through stdin; never shell-interpolate. `gh` output parsed as JSON (serde), never scraped, except the phase-1 create URL (line-shaped by contract).
- **Testing:** pure helpers unit-tested (payload builders, JSON deserialization, precondition gates, URL parse); `gh` interactions behind a binary-param seam (`create_pr_with(dir, "gh", …)`) exactly like `scan_staged_with`, so tests inject a fake binary. Command wrappers stay untested by convention (no AppHandle mock).
- **Settings:** none in phase 1 (draft toggle lives in the dialog). Revisit only if dogfooding demands a default-draft or default-base setting.
- **Events:** phases 1–3 need no new channel (`TASK_EVENT` + command return values suffice). Phase 4 gets its own scan channel via the platform.
- **Provenance:** pushes/creates happen in Rust, outside the PreToolUse ledger's jurisdiction; the durable record is the task fields + the PR itself. If an audit trail is later required, a `workflow/` log line at push/create is the cheap hook.

## 8. Build order

| # | Slice | Size | Depends on |
|---|---|---|---|
| 1 | `workflow/pr.rs` (probe, push, create, draft) + Task fields + CreatePRDialog + footer/manager UI | 1 session | — |
| 2 | `PrStatus` + card + remote-merged finalize + push-updates | small | 1 |
| 3 | comment fetch + fenced fix-run re-dispatch | medium | 1, 2 |
| 4 | PR Review scan sibling + post-review | large | 1, 2; sandbox for foreign PRs |

Open calls made here (flag if you disagree): PR create requires `verified` + full gauntlet (same bar as merge); no new TaskStatus/TaskKind; no background PR polling; thread-resolution deferred out of phase 3 v1.
