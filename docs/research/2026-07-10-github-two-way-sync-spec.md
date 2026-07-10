# GitHub two-way issue sync — build-ready spec

**Date:** 2026-07-10
**Ticket:** wayfinder #97 (direction approved; the four decisions below were grilled 2026-07-10 — encoded here, not re-litigated).
**Status:** SPEC. No code written. Extends the shipped Issue Triage intake half (`docs/research/2026-07-04-issue-triage-build-spec.md`) and reuses the PR system's hardened `gh` seam (`docs/research/2026-07-02-pr-system-design.md`).
**Scope of this document:** an implementer with zero session context runs PR 1 directly from §8.

---

## 0. The four locked decisions (encode; do not re-open)

1. **Writeback: FULL.** Nightcore maintains `nc:*` status labels on the linked GitHub issue, posts comments at convert + terminal states (done/failed), and lets the issue close via the native `Closes #N` keyword injected into the task's PR body. Label lifecycle must be idempotent (fixed colors/descriptions), degrade gracefully when the token lacks write scope, and be anti-churn (no label thrash on rapid state flaps).
2. **Intake: poll on app-window focus + the existing manual refresh.** No background daemon, no webhooks.
3. **Ownership: projections, no mirror.** GitHub is authoritative for the issue; Nightcore is authoritative for the task; each side *projects* events at the other. An externally-closed issue surfaces as an "issue closed upstream" chip on the task — the user decides. No conflict engine, no reconciliation state machine.
4. **Sync state: per-task serde-additive fields.** Linkage already exists via the task `sourceRef` (`issue-triage:<runId>` mint, `sidecar/issue_triage/convert.rs:121`); add the linked issue number, last-synced label + timestamps, and last-observed upstream state as `#[serde(default)]` fields on `Task`. No new store.

---

## 1. Scope

### In
- One new label vocabulary (`nc:*`, 5 labels) that Nightcore keeps in sync with a linked task's lifecycle on the GitHub issue it was converted from.
- Convert-time + terminal-state comments on the issue, built from structured task state (never raw model prose).
- `Closes #N` injection into a linked task's PR body so a merged PR closes the issue natively (no explicit close call from Nightcore).
- Focus-triggered intake: re-list open issues + detect upstream close/reopen when the app window regains focus, reusing the existing manual refresh path.
- An "issue closed upstream" chip on the task (projection-in), user-decided, no automatic task mutation.
- Serde-additive per-task sync fields + a global on/off toggle + a label-prefix setting.

### Out (explicit non-goals)
- **Webhooks** and any push-based delivery. Poll-only (decision 2).
- **Background daemon / timer polling.** Focus + manual refresh are the only triggers.
- **Linear / Jira / any non-GitHub provider.** GitHub via `gh` only.
- **Multi-repo tasks.** A task links exactly one issue in exactly one repo (the active project's remote).
- **A conflict/reconciliation engine.** Last-write-wins projection each direction; no merge logic (decision 3).
- **Auto-mutating the task from upstream** (e.g. auto-cancelling a run when the issue closes). The chip informs; the human acts.
- **Mirroring issue body/comments back into the task** beyond the convert-time snapshot Issue Triage already captures.
- **Bulk / retroactive labeling** of issues linked before this feature shipped (they backfill lazily on the next transition).

---

## 2. Data model delta

### 2.1 New `Task` fields (Rust — `store/task/model.rs`)

Add to `struct Task` (`store/task/model.rs:192`), following the exact serde-additive precedent already used for `pr_url`/`pr_number` (`store/task/model.rs:363-371`): `#[serde(default, skip_serializing_if = "Option::is_none")]` + `#[cfg_attr(test, ts(optional))]`, and initialize each to `None` in `Task::new` (`store/task/model.rs:376-419`).

```rust
/// GitHub two-way sync (#97). The issue this task was converted from, stamped at
/// convert time (`convert_issue_validation_to_task`). The DURABLE linkage: the
/// `sourceRef` (`issue-triage:<runId>`) resolves the issue number only through the
/// validation RunStore, which is capped + pruned (MAX_RUNS=50) — so a task whose
/// run was pruned would lose its issue link. This field makes writeback independent
/// of run retention. `None` for hand-created tasks and pre-#97 issue tasks (they
/// backfill lazily — see §2.3). Never patchable via TaskPatch.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_number: Option<u64>,

/// GitHub two-way sync (#97). The `nc:*` status label Nightcore last projected onto
/// the linked issue (the ANTI-CHURN key: a writeback that computes the same label
/// is a no-op, and the previous label is the one to remove). `None` until the first
/// successful label writeback.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_synced_label: Option<String>,

/// GitHub two-way sync (#97). Epoch-ms of the last successful label writeback.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_synced_at: Option<u64>,

/// GitHub two-way sync (#97). The last terminal COMMENT key posted to the issue
/// (`"converted"` | `"done"` | `"failed"`), so a Done→Backlog→Done flap can't
/// double-post. `None` until the first comment posts.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_comment_marker: Option<String>,

/// GitHub two-way sync (#97), projection-IN. The last upstream issue state observed
/// on a focus/manual poll (`"open"` | `"closed"`). Drives the "closed upstream"
/// chip. `None` until the first poll; never gates anything and never mutates the task.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_state: Option<String>,

/// GitHub two-way sync (#97). The last writeback DEGRADATION reason, surfaced as a
/// one-time UI notice (e.g. "sync paused: the token can't write labels on this
/// repo"). `None` when sync is healthy or off. Not a secret — never carries a token.
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(test, ts(optional))]
pub issue_sync_error: Option<String>,
```

Six `Option` fields, all omitted-while-unset so pre-#97 task JSON is byte-compatible. `issue_state_checked_at` (poll timestamp) is optional-nice and MAY be folded in later; it is not required for v1 behavior.

**Codegen touchpoints (Rust→TS, ts-rs):**
- `cargo test` regenerates `apps/web/src/lib/generated/Task.ts` from the derives. Do NOT hand-edit it.
- Add a legacy-JSON round-trip + camelCase-pinning test cloned verbatim from `pr_fields_default_none_and_are_serde_additive` (`store/task/model.rs:903-949`): assert each new field defaults to `None`, is omitted from the serialized object while unset, a pre-#97 legacy JSON string still deserializes, and populated values round-trip with camelCase keys (`issueNumber`, `issueSyncedLabel`, `issueSyncedAt`, `issueCommentMarker`, `issueState`, `issueSyncError`).

**Not in `TaskPatch`.** Like `pr_url`/`pr_number`, these fields are written only by the sync paths (convert stamp + `sync_issue_status` + `poll_issue_states`), never by a generic task patch. Do not add them to `store/task/patch.rs`.

### 2.2 Settings (Rust — `store/settings/model.rs`)

Two global-only fields on `struct Settings` (`store/settings/model.rs:22`), mirroring the opt-in network-mutating toggles `auto_commit_on_verified` / `sandbox_sessions` (`store/settings/model.rs:87-101`) — same serde-additive posture, same "global-only, no per-project override" call:

```rust
/// GitHub two-way sync (#97): master switch for issue writeback (labels + comments
/// + PR Closes-keyword). OFF by default — writeback MUTATES a (often public) GitHub
/// repo, so it is opt-in exactly like `auto_commit_on_verified` / `sandbox_sessions`.
/// Serde-additive: a settings file written before this field loads as `false`.
#[serde(default)]
pub issue_sync_enabled: bool,

/// GitHub two-way sync (#97): the prefix for the status labels Nightcore manages
/// (`nc:` → `nc:queued`, `nc:in-progress`, …). `None` ⇒ the default `"nc:"`.
/// Lets a project that already uses `nc:` for something else remap. Serde-additive.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub issue_label_prefix: Option<String>,
```

Wire both through `Settings::default()` (`:318` — `issue_sync_enabled: false`, `issue_label_prefix: None`) and add matching `Option` fields to `SettingsPatch` (`store/settings/patch.rs:139`) so the Settings form can toggle them. `issue_label_prefix` resolves via a helper `label_prefix()` returning `self.issue_label_prefix.as_deref().unwrap_or("nc:")`. No per-project override in v1 (note as a later extension).

### 2.3 Convert-time stamp (Rust — `sidecar/issue_triage/convert.rs`)

In `convert_issue_validation_to_task` (`sidecar/issue_triage/convert.rs:101`), immediately after `task.source_ref = Some(format!("issue-triage:{run_id}"))` (`:121`), stamp the durable linkage:

```rust
task.issue_number = Some(run.issue_number);
```

`run.issue_number` and `run.project_path` are on `IssueValidationRun` (`store/issue_triage.rs:144-149`). This is the ONLY new write in the convert path. Every other field defaults to `None`; the first `sync_issue_status` call (fired by the web observer when the task appears) does the initial `nc:queued` labeling + the "converted" comment. **Backfill for pre-#97 tasks:** a task with a `sourceRef` of `issue-triage:*` but `issue_number == None` resolves its number lazily on first sync by looking up the run (best-effort — a pruned run means no backfill, and the task simply never writes back; acceptable).

### 2.4 No new contract schemas required

The writeback + poll flow is entirely Rust-`gh`-seam + `Task` fields; it does **not** ride the engine NDJSON protocol, so nothing is added to `packages/contracts/src/*` or `contracts/generated.rs`. The web consumes only the new `Task` fields (via the regenerated `Task.ts`) and the new command return shapes (hand-declared in the bridge, like `IssueDetail` in `lib/bridge/commands/issues.ts:19`). This keeps the contract/codegen surface minimal — a point in favor of the "fields, not a store" decision.

---

## 3. Writeback engine

New Rust module tree `apps/desktop/src-tauri/src/workflow/issue_sync/` (sibling of `workflow/issue_triage/`), plus one async command in `sidecar/`. **Every GitHub mutation goes through the existing `gh` seam** (`git/gh.rs`) and the **per-root mutation lease** (`workflow/merge/lease.rs:82`), exactly like the issue-comment post already does (`sidecar/issue_triage/convert.rs:82`, `workflow/issue_triage/post.rs`).

### 3.1 Label vocabulary (5 labels, fixed colors)

Collapse the 7 `TaskStatus` variants into 5 stable labels so ordinary lifecycle churn (Backlog↔Ready, InProgress↔Verifying) does **not** re-label:

| Label (default prefix) | Color (hex) | Description | Meaning |
|---|---|---|---|
| `nc:queued` | `cccccc` | Queued in Nightcore | Backlog / Ready |
| `nc:in-progress` | `1d76db` | Being worked by a Nightcore agent | InProgress / Verifying |
| `nc:review` | `fbca04` | Awaiting human review/approval in Nightcore | WaitingApproval |
| `nc:done` | `0e8a16` | Completed in Nightcore (not yet merged) | Done && !merged |
| `nc:failed` | `d73a4a` | Failed in Nightcore | Failed |

Colors/descriptions are constants in `issue_sync/labels.rs`. A merged task (or a merged PR) removes the `nc:*` label entirely — the issue's closed state comes from `Closes #N`, not a label.

### 3.2 Transition → action table

`desired_label(task) -> Option<&'static str>` and `comment_key(task) -> Option<&'static str>` are pure functions of `Task` (unit-tested without an `AppHandle`). The writeback observer (§3.6) fires `sync_issue_status(task_id)` on every `nc:task` event for an issue-linked task; the command computes the row below and applies only the *deltas*.

| Task state (status + flags) | Desired `nc:*` label | Comment (once) | PR keyword |
|---|---|---|---|
| Just converted (task minted) | `nc:queued` | `converted` — "Nightcore is tracking this issue as task «title»." | — |
| `Backlog` / `Ready` | `nc:queued` | — | — |
| `InProgress` / `Verifying` | `nc:in-progress` | — | — |
| `WaitingApproval` | `nc:review` | — | — |
| `Done` && `!merged` | `nc:done` | `done` — "Completed by Nightcore. Summary: …" | — |
| `Done`/any && `merged` (or PR merged) | *(remove all `nc:*`)* | — | `Closes #N` in the task's PR body auto-closes the issue on merge |
| `Failed` | `nc:failed` | `failed` — "The Nightcore run failed: «error»." | — |

**Anti-churn rules (the heart of decision 1):**
- **Labels:** apply only when `desired_label(task) != task.issue_synced_label`. Equal ⇒ the whole command is a no-op (zero `gh` calls). A flap InProgress→Verifying→InProgress computes `nc:in-progress` throughout ⇒ no writes.
- **Comments:** post only when `comment_key(task)` is `Some(k)` **and** `task.issue_comment_marker != Some(k)`. So `done`/`failed`/`converted` each posts at most once; a Done→Backlog→Done re-run does not re-post `done` (marker already set). A genuinely NEW terminal (Done then later Failed) posts once for each because the key differs.
- **Coalescing:** the web observer debounces per-task (§3.6) so a burst of rapid `nc:task` emits collapses to one `sync_issue_status` call carrying the latest state.

### 3.3 Label idempotency (the `gh api` REST seam)

Clone the idempotent, injection-safe posture of `post_issue_comment_with` (`workflow/issue_triage/post.rs:184-223`): `gh api` REST, decimal `u64` issue number in the path, controlled label names (our own `nc:*` — not attacker text) but still never shell-interpolated. Three primitives in `issue_sync/labels.rs`, each binary-parameterized (`_with(dir, binary, …)`) so tests inject a fake `gh`:

1. **`ensure_label(dir, name, color, desc)`** — `gh api repos/{owner}/{repo}/labels --method POST -f name=<n> -f color=<hex> -f description=<d>`. Tolerate HTTP 422 `already_exists` as success (idempotent create). **Cache** the `(project_path, name)` pair in an in-memory `OnceLock<Mutex<HashSet>>` after first success so steady-state writebacks skip the ensure call. (A crashed/edited label re-creates on next process start — acceptable; `--force` semantics are not needed because we never rewrite an existing label's color.)
2. **`add_label(dir, issue_number, name)`** — `gh api repos/{owner}/{repo}/issues/{n}/labels --method POST -f labels[]=<name>`. This is **additive** — it never touches the user's other labels (unlike the `PUT …/labels` replace, which would nuke them — do NOT use PUT).
3. **`remove_label(dir, issue_number, name)`** — `gh api repos/{owner}/{repo}/issues/{n}/labels/<name> --method DELETE`. Tolerate 404 (label already absent) as success.

A label transition is therefore: `ensure_label(desired)` → `add_label(desired)` → (if `issue_synced_label` was `Some(prev)` and `prev != desired`) `remove_label(prev)`. We know `prev` from the task field, so **no read/list call is needed** to switch labels. Merge (`desired == None`) is just `remove_label(prev)`.

### 3.4 Terminal comments

`build_sync_comment(key, task) -> String` — pure, deterministic (preview-safe), reusing the humanize/footer style of `build_issue_comment_body` (`workflow/issue_triage/post.rs:56-135`). Body is built from **structured task fields** (title, `summary`, `error`, `pr_url`) — never transcript or raw model prose — with a `_Posted by Nightcore — automated status update._` footer. Posted via the existing `post_issue_comment` seam (`workflow/issue_triage/post.rs:172`), reused as-is. On success, stamp `task.issue_comment_marker = Some(key)`.

### 3.5 `Closes #N` injection (PR body)

The issue closes **natively** on PR merge via the `Closes #N` keyword — Nightcore never issues an explicit close. Two layers:
- **Pre-fill (visible, human-editable — PR-system principle 5):** when the create-PR dialog opens for a task with `issue_number == Some(n)`, append `\n\nCloses #n` to the default/drafted body so the user *sees* it before confirming. The draft path is `pr_msg::draft_for` (`workflow/pr_msg.rs:48`) with the deterministic fallback = task title + description; append the `Closes` line to whichever body the dialog pre-fills.
- **Defensive ensure (Rust, idempotent):** in `create_pr_task_blocking` (`workflow/pr/create.rs:87`), right before `create_or_recover_with` (`:161`), if `task.issue_number` is `Some(n)` and `body` does not already contain a `closes #n` / `fixes #n` / `resolves #n` reference (case-insensitive), append `\n\nCloses #n`. This guarantees the keyword lands even if the user edited it out, without duplicating it when present. Pure helper `ensure_closes_keyword(body, n) -> String`, unit-tested.

No new gh call — the keyword rides the existing `gh pr create --body-file -` stdin body (`workflow/pr/create.rs:353-364`).

### 3.6 Command + observer wiring (where the transitions hook)

**Command:** `sync_issue_status(app, task_id)` — async `#[tauri::command]` + `spawn_blocking` (the WKWebView rule; it shells to `gh`), in `sidecar/issue_sync.rs` (or `sidecar/issue_triage/` sibling). Body:
1. Early-out if `settings.issue_sync_enabled == false`.
2. Load task; early-out if `task.issue_number == None` (try lazy backfill via `sourceRef`→run first, §2.3).
3. Guard the active project == the task's project (the `require_project` + path check, `sidecar/issue_triage/convert.rs:73-78`); the project root is the `gh` cwd that resolves `{owner}/{repo}`.
4. Compute `desired_label` + `comment_key`; if both are no-ops (label unchanged, comment already marked) return early — **zero `gh` calls**.
5. Acquire the **per-root mutation lease** (`acquire_root_lease(project_path, "syncing the issue status")`, `workflow/merge/lease.rs:82`) — writeback mutates the shared repo (a GitHub write from its root), so it serializes against merge / commit / pull-base / comment-post, exactly like the existing comment post (`sidecar/issue_triage/convert.rs:82`).
6. Run the label delta (§3.3) then the comment (§3.4) under the degradation ladder (§3.8).
7. Stamp `issue_synced_label` / `issue_synced_at` / `issue_comment_marker` best-effort (a store hiccup must not turn a landed GitHub write into a failure — the `mark_posted` pattern, `sidecar/issue_triage/convert.rs:91-93`), emit `nc:task`.

**Observer (web — the transition hook):** a new `useIssueSync` hook (sibling of the auto-commit observer — the established idiom: a web observer that fires an IPC on task-state transitions, see `AutoModeOptions`/`useTaskWorkflowActions` firing `commitTask`). It listens to the app-wide `nc:task` stream (every status change re-emits it — the `apply_and_emit` contract, `sidecar/lifecycle.rs:157`), filters to tasks with `issueNumber != null`, **debounces per task (≈500 ms)** to coalesce flaps, and fires `syncIssueStatus(taskId)` (fire-and-forget; errors surface via the `issue_sync_error` field, not a toast storm). It runs only when `settings.issueSyncEnabled` is true.

> **Why the web observer, not a Rust hook in `apply_and_emit`:** it matches the shipped `auto_commit_on_verified` idiom exactly, keeps network I/O off the orchestration hot path (`apply_and_emit`/`finish_run` stay pure and non-blocking — `sidecar/lifecycle.rs`), gives free debounce/coalescing, and is trivially gated by the settings toggle. The projection model (decision 3) makes "sync the *latest* state on the next `nc:task`" correct: last-write-wins, idempotent, no ordering requirement. Transitions that fire while the app is closed simply project on the next relevant `nc:task` (e.g. boot reconcile re-emits). *(A Rust-side hook at `apply_and_emit:157` is the alternative if a fully-headless writeback is ever required; noted, not chosen for v1.)*

### 3.7 Idempotency, retry, and rate-limit posture

- **Idempotency:** every primitive is idempotent (ensure=tolerate-422, add=additive, remove=tolerate-404, comment=marker-guarded). Re-firing `sync_issue_status` for an unchanged task is a pure no-op.
- **Retry:** none automatic. A failed writeback leaves `issue_synced_label` unchanged, so the next `nc:task` (or the next transition) naturally re-attempts. `gh` runs are already deadline-bounded (`run_gh_bounded`, `git/gh.rs:111`) so a black-holed GitHub errors out and releases the lease instead of pinning it.
- **Rate-limit budget:** steady state ≤ 2 REST calls per *label-changing* transition (add + remove-prev; ensure is cached), 0 calls when the label is unchanged, +1 REST call for a terminal comment (posted once). Poll (§4/§5) is 1 GraphQL call for the whole open list + at most 1 targeted `gh issue view` per *suspected-closed* linked task. Against GitHub's 5000 req/hr authenticated budget this is negligible; the debounce is the real throttle.

### 3.8 Permission-degradation ladder

The `gh` token (keychain-backed, Nightcore stores none — `git/gh.rs:9-14`) may lack `issues:write`. A 403/404-forbidden on a mutation must degrade, never retry-storm:

1. **Full** — labels + comments + `Closes #N`. The happy path.
2. **Comments-only** — if a label mutation returns 403/insufficient-scope, skip labels for this project (cache the downgrade in-memory, keyed by `project_path`, so we probe once — not on every transition), keep posting terminal comments, and set `task.issue_sync_error = Some("sync running comments-only: the token can't manage labels on this repo")`.
3. **Silent-off** — if the comment post also 403s, disable writeback for this project (cached), set `task.issue_sync_error = Some("issue sync paused: the token lacks write access to this repo")`, and surface a **one-time** UI notice (a chip/banner keyed off `issueSyncError`, dismissible). Never auto-retry; the user fixes the token scope and re-enables.

`Closes #N` is unaffected by the ladder — it needs no issue write scope (it rides the PR body, which the user already has push rights to). Detection reuses `map_gh_failure` (`git/gh.rs:69`) + the `errors[]`-first parse already in `map_post_failure` (`workflow/issue_triage/post.rs:140`); a 403 signature (`gh`'s stderr `HTTP 403` / `Resource not accessible`) is classified as a scope degradation, any other failure is a transient error (no downgrade, natural retry next transition).

---

## 4. Intake poll (focus-triggered)

Decision 2: poll on window focus + the existing manual refresh. **There is no existing window-focus listener** in the web or Rust (verified: only component-local `focus`/`focusout` handlers exist). Introduce one, DOM-level (a WKWebView fires DOM `focus`/`visibilitychange` reliably; `@tauri-apps/api` ^2.11.0 is available if a native `onFocusChanged` is preferred, but the DOM route needs no new capability).

- **Focus trigger hook** `useWindowFocusPoll(onFocus)` — registers `window.addEventListener('focus', …)` + `document.addEventListener('visibilitychange', …)` (fire when `visibilityState === 'visible'`), debounced ≈1 s so an alt-tab storm triggers one poll. Cleanup on unmount. Lives in `apps/web/src/lib/` or `AppShell/hooks/`.
- **What a poll does:**
  1. **Re-list open issues** — call the existing `listProjectIssues()` (`lib/bridge/commands/issues.ts:42` → `list_open_issues`, `workflow/issue_triage/list.rs:199`). This is the same fetch the Issues view's manual refresh already runs, so intake dedupes trivially: the list is keyed by issue number, the view already renders it, and the focus poll just re-invokes the same loader (no separate list). Reuse `useIssueList`'s existing fetch (`components/issues/IssueList/IssueList.hooks.ts`).
  2. **Surface new issues** — issues in the fresh list not present in the prior render are new since last look; the list already handles this (newest-updated-first ordering, `list.rs` `orderBy: UPDATED_AT DESC`). No new-issue *notification* in v1 — the refreshed list IS the surfacing (a subtle "n new" affordance is a later polish, out of scope).
  3. **Project upstream state** — §5.
- **Gating:** the focus poll only runs the issue-list refresh when the Issues view is mounted/active (don't fetch a list nobody is looking at). The **upstream-state projection (§5) runs regardless of the active view**, because it updates chips on *board* tasks — but it is cheap (one GraphQL call) and still only when `issue_sync_enabled` (or a lighter `issue linkage exists`) is true.

**Dedupe vs the existing triage list:** the Issue Triage list (`IssueSummary`) and the sync-linked tasks are keyed the same way — by issue `number` within the active project. The focus poll reuses the existing list fetch, so there is exactly one source of open-issue truth; sync adds no parallel list.

---

## 5. Upstream-event projection ("closed upstream" chip)

Decision 3: GitHub authoritative for the issue; project the close/reopen at the task; **no automatic task mutation.**

- **Detection (poll-time, cheap):** `list_open_issues` returns only OPEN issues (`list.rs` `states: OPEN`). For each board task with `issue_number == Some(n)` whose task is **not already terminal-merged** (i.e. we still care), check whether `n` is present in the fresh open-issue set:
  - **Present ⇒** `issue_state = "open"` (clears a stale chip if the issue was reopened).
  - **Absent ⇒** it *might* be closed, or it might just have fallen off the `ISSUES_LIST_MAX` cap (`list.rs`). **Confirm with a targeted read** — `gh issue view <n> --json state,stateReason` (or a batched GraphQL fetch of the suspected set) — before setting `issue_state = "closed"`. This guards against the list-cap false positive. `stateReason` (`completed` / `not_planned`) can flavor the chip copy later.
- **Command:** `poll_issue_states(app) -> Vec<(u64, String)>` — async `spawn_blocking`, reads-only (no lease needed — a GET). Collect the linked issue numbers from the task store, run the one-GraphQL-call state fetch, and `apply_and_emit` `task.issue_state` for each changed task. Reuses the `gh api graphql` idiom (`-F`, `-f query=`, `errors[]`-first parse) already in `workflow/issue_triage/list.rs:204-234`. Can share one query fetching multiple issues via GraphQL aliases.
- **UI chip:** an "Issue #N closed upstream" chip on the task card/detail when `issueState === "closed"` and the task is not itself Done/merged (i.e. the divergence is interesting). It is **informational only** — clicking it opens the issue on GitHub. **No automatic task mutation**: Nightcore never cancels the run, moves the card, or closes the task. The user decides (keep working, or drag to Done/Failed themselves).
- **Reopen:** symmetric — if a previously-`closed` issue reappears in the open list, `issue_state` flips back to `"open"` and the chip clears. This is the only "reconciliation" and it is a pure last-observed projection, not a state machine.

---

## 6. Security

- **Untrusted issue content:** every GitHub-sourced string (issue title/body/comments/labels, `stateReason`) is attacker-controlled — the same posture Issue Triage already enforces (`packages/contracts/src/issue-triage.ts:21-49`). Sync introduces **no new prompt surface** (writeback builds comments from *structured task fields*, not model prose or issue text), so there is nothing new to fence into a session. Any GitHub text rendered in the chip UI uses the existing untrusted-content framing. Task titles that become comment text pass through the existing `sanitize_minted_title` guarantees at mint (`store/task/model.rs:450`).
- **`gh` argv hygiene:** label names are our own controlled constants (`nc:*`), issue numbers are `u64` rendered decimal (injection-safe — the `post.rs:184` contract), and all mutations use `gh api` with `-f k=v` fields / stdin body — never a shell-interpolated string. Reuse `run_gh_bounded` (`git/gh.rs:111`) which applies the git-env scrub (`scrub_git_env`) so `gh`'s inner git can't be hijacked via `GIT_SSH_COMMAND` et al.
- **Token scopes required:** classic PAT `repo` (or fine-grained: **Issues: Read and write** for labels/comments, **Pull requests: Read and write** already required by the PR arc, **Contents: Read** for the repo). `Closes #N` needs only the push rights the user already has. Nightcore stores **no token** — `gh` owns auth (keychain-backed), the `claude`/gitleaks precedent (`git/gh.rs:9-14`). Insufficient scope degrades per §3.8, never crashes.
- **No secrets in logs:** log at INFO the `task_id` / `issue_number` / label transitions only — never tokens, never full issue bodies. The `issue_sync_error` field carries a human message, never a token (mirrors the `sdk_session_id` "not a secret, never logged at telemetry" note, `store/task/model.rs:323`).
- **Human-gated where it must be:** writeback labels/comments are automated (that IS decision 1 — the label is a mechanical status projection, low blast radius, reversible), but the **`Closes #N` PR body remains human-editable before the PR is created** (PR-system principle 5) and PR creation itself stays behind its confirm dialog. Posting the *validation verdict* comment stays behind its existing preview dialog (`preview_issue_comment`); sync's *status* comments are the only new automated post, and they are structured + footer-marked as automated.

---

## 7. Test plan (per tier, repo idioms)

**Contracts / codegen:** none new (§2.4). The `Task` field additions are covered by the Rust round-trip test below; `cargo test` regenerates `Task.ts` and CI's ts-rs-regen gate asserts no drift.

**Rust unit (the bulk — pure helpers + fake-`gh` seams, the `secret_scan`/`post.rs` fixture idiom):**
- `Task` serde-additive: clone `pr_fields_default_none_and_are_serde_additive` (`model.rs:903`) for the six new fields — default `None`, omitted-while-unset, legacy JSON deserializes, camelCase round-trip.
- `desired_label(task)` / `comment_key(task)` truth table — every `TaskStatus` × `{merged, !merged}` × `{issue_synced_label present/absent}` maps to the §3.2 row; anti-churn (equal label ⇒ `None` delta; marker set ⇒ comment `None`).
- `ensure_closes_keyword(body, n)` — appends when absent, no-op when `Closes #n`/`Fixes #n`/`Resolves #n` already present (case-insensitive), correct number.
- Label primitives with a fake `gh` script (the `create_pr_with`/`post_issue_comment_with` fixture pattern, `workflow/pr/create.rs:701` / `post.rs:225`): `add_label` POSTs `labels[]`, `remove_label` DELETEs the right path and tolerates a 404 exit, `ensure_label` tolerates 422, and the label switch issues add+remove in order.
- Degradation ladder: a fake `gh` returning HTTP 403 downgrades to comments-only then silent-off and stamps `issue_sync_error`; a transient failure does NOT downgrade.
- `build_sync_comment` determinism (preview == post bytes, the `post.rs:289` guarantee) + structured-only (no transcript).
- Poll: `poll_issue_states` parse — an open-set-absent + `gh issue view state=CLOSED` sets `"closed"`; absent-but-view-open (cap false positive) sets `"open"`; reopen flips back.
- Convert stamp: `convert_issue_validation_to_task` stamps `issue_number` from the run.

**Node/engine:** no engine change (writeback + poll are Rust-only). No `packages/engine` test delta.

**Web (vitest + the `@nightcore/eslint-plugin` folder-per-component gate):**
- `useIssueSync` observer: debounces per task, fires `syncIssueStatus` only for `issueNumber != null` tasks, only when `issueSyncEnabled`, coalesces a flap burst to one call (fake timers).
- `useWindowFocusPoll`: `focus` + `visibilitychange(visible)` trigger the callback, debounced; cleanup removes listeners.
- Chip render: `issueState === "closed"` on a non-terminal task renders the chip; opening links to the issue; no task mutation dispatched.
- `issue_sync_error` surfaces the one-time degradation notice.
- Run `bun run lint` + `bun run lint:meta` (folder-per-component, no-state-in-body, no-cross-feature-imports; and the new command must be named in the relevant `AGENTS.md` if a wired lint rule requires it — the agent-contract-parity trap).

**Manual dogfood (deferred to the end, like the PR arc):** on the Nightcore repo, convert a scratch issue → task; watch `nc:queued` appear, run it and watch `nc:in-progress` → `nc:done`; create its PR and confirm the body carries `Closes #N` and the merged PR closes the issue; close the issue on GitHub, focus the app, confirm the "closed upstream" chip; revoke label scope and confirm the comments-only → silent-off ladder with the UI notice.

---

## 8. PR slicing (ordered, each independently green)

Each PR is small, self-contained, and passes the full gate battery (§9) on its own. Order: **contracts/fields → writeback engine → labels+live-wiring → intake poll+chip.**

### PR 1 — Data model + settings + convert stamp (foundation, no behavior)
Lands the serde-additive fields and the toggle; nothing writes back yet.
- `store/task/model.rs` — the six `Task` fields (§2.1) + `Task::new` init + the cloned round-trip/pinning test.
- `store/settings/model.rs` — `issue_sync_enabled` + `issue_label_prefix` + `Default` + `label_prefix()` helper; `store/settings/patch.rs` — matching `SettingsPatch`/`SettingsOverride`(no) fields (global-only).
- `sidecar/issue_triage/convert.rs:121` — stamp `task.issue_number = Some(run.issue_number)`.
- `cargo test` regenerates `Task.ts` / `Settings.ts` (commit the regen).
- Web: consume the new optional `Task` fields where needed (types only; no UI). Settings form gets the toggle + prefix input (can be a plain follow-on within this PR or PR 3 — keep the *store* wiring here).
**Green because:** additive fields + a passing round-trip test + regenerated codegen; no runtime behavior to break.

### PR 2 — Writeback engine core (Rust, fake-`gh` tested; command exists, not yet auto-fired)
- `workflow/issue_sync/mod.rs` + `labels.rs` (§3.3 primitives + ensure-cache), `transition.rs` (`desired_label`/`comment_key` §3.2), `comment.rs` (`build_sync_comment` §3.4), `degrade.rs` (the ladder + per-project downgrade cache §3.8).
- `sidecar/issue_sync.rs` — `sync_issue_status(app, task_id)` command (§3.6 body): settings gate, project guard, delta compute, **`acquire_root_lease`**, apply, stamp fields, emit.
- Register the command in `lib.rs` (the `invoke_handler!` list near `sidecar::list_project_issues`, `lib.rs:236`).
- Bridge: `syncIssueStatus(taskId)` wrapper in `lib/bridge/commands/issues.ts` (no-op outside Tauri).
- Tests: all Rust unit tests in §7 (transition table, label primitives, degradation, comment determinism).
**Green because:** pure helpers + fake-`gh` seam tests; the command is invocable but nothing calls it in the UI yet, so no live GitHub traffic.

### PR 3 — Live wiring: label lifecycle + observer + `Closes #N` + settings UI
Makes writeback actually run end-to-end.
- `useIssueSync` web observer (§3.6) registered in `AppShell.hooks.ts` alongside the other app-wide observers; debounce; gated on `issueSyncEnabled`.
- `Closes #N`: `ensure_closes_keyword` in `workflow/pr/create.rs` (defensive, `:161`) + the create-PR dialog default/draft body pre-fill (`workflow/pr_msg.rs` fallback + the dialog's default-body builder).
- Settings UI: the toggle + label-prefix input in `SettingsView` (if not fully landed in PR 1) + the `issueSyncError` one-time notice surface.
- `issue_sync_error` chip/banner component (degradation notice).
- Tests: `useIssueSync` observer + `ensure_closes_keyword` + settings-form wiring.
**Green because:** the observer is inert until `issueSyncEnabled` (default false); the `Closes` injection is idempotent and covered.

### PR 4 — Intake focus-poll + upstream-closed chip (projection-in)
- `useWindowFocusPoll` hook (§4) + wire it to re-run the existing `listProjectIssues` loader (Issues view) and the new `poll_issue_states`.
- `poll_issue_states(app)` command (§5) + `pollIssueStates` bridge wrapper + `lib.rs` registration.
- `workflow/issue_sync/state.rs` — the open-set-diff + targeted `gh issue view` confirm + GraphQL batch fetch.
- "Closed upstream" chip component on the task card/detail (informational; opens the issue; no mutation).
- Tests: `useWindowFocusPoll` triggers/debounce, `poll_issue_states` parse (closed/false-positive/reopen), chip render.
**Green because:** reads-only (no lease, no mutation); the chip is purely informational.

---

## 9. Verification gates (the standard battery)

Run before declaring each PR done (the repo's four-tier gate + regen):
- **Rust:** `cargo test` (in `apps/desktop/src-tauri`) — includes the **ts-rs regen** that rewrites `apps/web/src/lib/generated/*` from the Rust derives; commit the regen, and CI's regen-drift gate must be clean. `cargo clippy` + `cargo fmt` (the `rust-checks` CI job with `rustfmt.toml` — do NOT put clippy/fmt in a lint-meta rule).
- **Web:** `bun run --filter @nightcore/web typecheck` (root `tsc -b` does NOT typecheck web), `bun run --filter @nightcore/web test`.
- **Node/engine:** `bun run --filter @nightcore/engine test` (no delta expected, but run it — parity gates check scan-family symmetry).
- **Lint:** `bun run lint` (the `@nightcore/eslint-plugin` — folder-per-component, no-state-in-body, no-cross-feature-imports) **and** `bun run lint:meta` (zero violations on a clean tree). Trap: `bun run lint` fails if a wired `nightcore/*` rule isn't named in some `AGENTS.md` (agent-contract-parity) — if a new command/module triggers a wired rule, name it.
- **Codegen prereq for a desktop build:** `bun run --filter @nightcore/sidecar compile` before any desktop `cargo build` (externalBin).
- **Log-level check:** sync writes log at INFO (git ops at `debug!` are invisible in the INFO+ log file); confirm a writeback leaves a legible INFO trail without leaking bodies/tokens.

---

## 10. Existing-code contradictions / refinements found (surface, don't silently absorb)

1. **`sourceRef` alone can't reach the issue number — and the run is prunable.** Decision 4 says "linkage already exists via the task `sourceRef`." True for *navigation*, but the token is `issue-triage:<runId>` (`source-ref.ts:46`, `convert.rs:121`) — it carries the **runId, not the issue number**. Resolving the number requires `IssueValidationStore.get(runId)`, and that store is a `RunStore` **capped at `MAX_RUNS = 50` and pruned oldest-first** (`store/run_store.rs:35,293-319`). A converted task whose validation run has since been pruned would lose its issue linkage entirely, silently breaking writeback. **Refinement (kept within decision 4's "add fields" spirit):** persist `issue_number` **directly on the `Task`** at convert time (§2.3). This makes the decision correct/robust rather than re-opening it. (The `project_path` for `{owner}/{repo}` comes from the active-project guard, not the run, so it is not affected.)

2. **No window-focus listener exists anywhere.** Decision 2 assumes a focus trigger "where app-window focus is already observable." It is **not** — the only `focus` handlers in the tree are component-local (`Menu`, `ToolbarOption`, `PrFilterBar`). PR 4 introduces the first app-level focus listener (DOM `window 'focus'` + `visibilitychange`); `@tauri-apps/api` ^2.11.0 offers a native `onFocusChanged` alternative if the DOM route proves unreliable in WKWebView. Flagged so the implementer budgets for building it, not wiring an existing one.

3. **`list_open_issues` returns OPEN only — closed detection needs a second read.** Decision 3's "closed upstream" projection can't be read off the existing list (it filters `states: OPEN`, `list.rs`). Absence from the list is ambiguous (closed vs fell off the `ISSUES_LIST_MAX` cap), so §5 adds a targeted `gh issue view <n> --json state` confirm before flipping `issue_state`. Not a contradiction, but a non-obvious extra `gh` read the naive "diff the list" approach would get wrong (false-positive closes).

4. **The `nc:` label prefix collides with Nightcore's own branch/worktree prefix (`nc/<taskId>`).** Cosmetic only (labels use `nc:`, branches use `nc/`), but the shared mnemonic is why `issue_label_prefix` is configurable (§2.2) — a project already using `nc:` for its own labels can remap without touching branch naming.

5. **Writeback should default OFF despite "FULL" writeback.** Decision 1 fixes the *capability* (full), not the *default*. Because writeback mutates a (frequently public) GitHub repo, the safe default is opt-in — consistent with the two existing network/OS-mutating toggles (`auto_commit_on_verified`, `sandbox_sessions`, both `false` by default, `store/settings/model.rs:87-101`). Encoded as `issue_sync_enabled: false`. If the intent was on-by-default, that is a one-line flip in `Settings::default()` — flagged so it's a conscious choice, not an accident.
