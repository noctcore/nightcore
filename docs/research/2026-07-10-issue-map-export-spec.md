# Build spec: GitHub issue-map export (scan findings → a native sub-issue map)

**Date:** 2026-07-10
**Ticket:** wayfinder #112 (issue-map export) — direction approved; the five decisions below
were grilled 2026-07-10 on issue #112. Encoded here, not re-litigated; implement.
**Status:** build-ready SPEC. No code written. An implementer with zero session context runs
**PR 1** directly from §7.
**Prior art (read for context, not for decisions):**
- `docs/research/2026-07-10-github-two-way-sync-spec.md` (#97) — the shared `nc:*` label
  vocabulary, the `gh api` REST idioms, the permission-degradation ladder, and the labels-are-
  the-discovery-mechanism posture. Export ships **before** #97 (decision 5) and therefore
  **creates the shared label home** #97 later extends (§3.7).
- `docs/research/2026-07-10-trust-report-build-spec.md` (#91, PR #113) — the canonical
  Rust→TS ts-rs discipline, and the **GitHub-safe fence/sanitize helpers** in
  `workflow/trust/render.rs` this spec REUSES rather than duplicates (§3.6).
- `docs/research/2026-07-04-issue-triage-build-spec.md` — the intake half; the issue-comment
  post seam (`workflow/issue_triage/post.rs`) whose `gh api … --input -` + `errors[]`-first
  parse this spec clones for issue/sub-issue creation.

> Each PR in §7 is independently green against all four gates (rust / node / web / plugin, §9).

---

## 1. What this is (and is NOT)

The issue-map export is a **read-only projection of an already-completed scan onto GitHub**. It
takes a persisted, `completed` scan run (Insight, Scorecard, or the Enforce/conventions half of a
Harness run) and mints, on GitHub:

- **one parent "map" issue** — a scan summary (executive narrative + deterministic grouping,
  counts, provenance, and a `supersedes #N` link to any prior map), and
- **one sub-issue per finding**, attached to the parent through GitHub's **native sub-issue
  relationship** (REST `POST …/issues/{n}/sub_issues`).

It is therefore **aggregation + rendering + posting over instrumentation that already exists** —
zero new persistence in `.nightcore/`, zero change to the scan run shapes, zero new mint prefix.
The scan runs are read **verbatim and read-only** off their existing stores
(`store/insight.rs`, `store/scorecard.rs`, `store/harness/`).

**It is fully ORTHOGONAL to convert-to-task.** It never mints a board task, never touches a
`sourceRef`, and never calls the shared convert protocol (`sidecar/convert.rs`). The six mint
prefixes are frozen (`apps/web/src/lib/source-ref.ts` REGISTRY: `insight`, `scorecard`,
`harness`, `harness-proposal`, `pr-review`, `issue-triage`). Export adds none.

**Grouping/ordering/counts are DETERMINISTIC** from the findings' existing `category`/`severity`/
`grade`/coverage-`status` fields (§3.4). Exactly **one cheap, fail-open LLM pass** writes the
parent's executive summary + per-group intros (§3.5); if it fails, export proceeds with
deterministic text. No agent-invented structure ever reaches GitHub.

**Out for v1 (explicit non-goals):**
- **PR Review + Issue Triage** as export targets — their outputs already live on GitHub
  (decision 1).
- **Harness Harden proposals** (task-shaped `StoredHarnessProposal`) — the Enforce target is the
  **conventions** half only: `StoredConventionFinding` + `StoredRuleCoverageGap` (§3.4c).
- **Fingerprint matching / two-way reconciliation.** Every export mints a FRESH map; a prior map
  is superseded by link, never diffed (decision 4).
- **Any new store, event, or `.nightcore/` layout.** The preview payload is a transient ts-rs
  value; the GitHub issue numbers are not persisted locally (the prior map is re-discovered by
  label, §3.10).
- **A hard sub-issue cap.** A soft preview warning fires above ~50 sub-issues (§3.9); the user
  decides.

---

## 2. Decision record (grilled 2026-07-10, issue #112)

| # | Decision | Outcome |
|---|---|---|
| 1 | Targets | **The 3 codebase scans:** Insight findings (Understand/Find), Scorecard readings (Understand/Grade), Enforce output (conventions + rule-coverage gaps). **PR Review + Issue Triage EXCLUDED** — already on GitHub. |
| 2 | Structure | **One parent "map" issue per export** (scan summary, grouping, counts) **+ one sub-issue per finding**, attached via GitHub's **native sub-issue** relationship (REST). |
| 3 | Authoring | Grouping/ordering/counts are **DETERMINISTIC** from existing category/severity fields. **ONE cheap no-tool LLM pass** writes the parent's exec summary + group intros. No agent-invented structure. **Fail-open:** LLM failure ⇒ deterministic text, export still proceeds. |
| 4 | Re-export | Every export mints a **FRESH map.** If a prior map exists for that project+scan-kind, the new parent links it (`supersedes #N`), and the UI offers to close the old parent + its open sub-issues. **No fingerprint matching in v1.** |
| 5 | Queue | Builds **after** the Trust Report wave (spec now); **ahead of** sync #97. Export therefore **creates** the shared `nc:*` label home #97 will extend. |

**Locked defaults:**
- **Human-gated FULL PREVIEW** before any GitHub write: the parent body + every sub-issue title,
  one-click cancel. Model it on the PR-reviewer's human-gated post flow and the `CreatePRDialog`
  confirm shape (`apps/web/src/components/worktree/CreatePRDialog/CreatePRDialog.tsx`) — a
  `<Modal>` gate whose confirm footer states exactly what will happen, and where **Enter is NOT
  wired to confirm** (an irreversible GitHub write takes an explicit click).
- **Labels share the #97 `nc:*` vocabulary** with **ensure-at-use** creation. Design ONE shared
  vocabulary (§3.7). Additions this feature introduces (`nc:map`, `nc:finding`, and the
  per-scan-kind `nc:insight` / `nc:scorecard` / `nc:enforce`) are **flagged** as additions and
  justified — the per-scan-kind labels are also the **discovery mechanism** for the prior map
  (decision 4).
- **Untrusted finding text** is rendered via the **fence/sanitize helpers that shipped in
  `workflow/trust/render.rs` (PR #113)** — variable-length backtick fences + control-char
  sanitize. REUSE, don't duplicate (§3.6).
- **Target repo = the project's origin remote** via the existing `gh` seam — resolved from the
  run's `project_path` as the `gh` cwd, never a raw URL over IPC (§3.2).
- **Soft preview warning above ~50 sub-issues**, no hard cap.
- **Parent body carries scan provenance** — kind, runId, ISO timestamp (§3.4).
- **Fully orthogonal to convert-to-task** — no task minting, no `sourceRef` changes; the 6 mint
  prefixes are frozen.

---

## 3. Design — tier by tier

### 3.1 Contracts + type flow (Rust → TS via ts-rs, NOT zod)

Everything the web needs is Rust-authored (aggregated from Rust stores + composed for GitHub), so
it follows the `GauntletResult`/`TrustReport` codegen discipline, **not** the zod-first path:
`#[derive(Serialize)]` + `#[cfg_attr(test, derive(TS))]` + `#[cfg_attr(test, ts(export,
export_to = "…"))]`, exactly like `store/insight.rs:36-45` and `workflow/gauntlet/contract.rs`.
`cargo test` regenerates `apps/web/src/lib/generated/*`; the new types register in the `export!`
block in `bindings/export.rs:74` beside `InsightRun`/`StoredFinding` (`:123-124`) /
`ScorecardRun` (`:130`). Never hand-edit generated files.

**Home:** new file `apps/desktop/src-tauri/src/workflow/issue_map/contract.rs`. The one payload
the web renders in the preview dialog (representative — final field set is the implementer's; the
split + provenance are locked):

```
IssueMapPreview {
  scan_kind: String,          // "insight" | "scorecard" | "enforce" (wire string)
  run_id: String,
  generated_at: String,       // ISO-8601 UTC, minted ONCE at preview (preview == post, §3.8)
  parent_title: String,       // deterministic (e.g. "Nightcore Insight map — 24 findings")
  parent_body: String,        // the FULL rendered parent markdown (exec summary + groups + counts
                              //   + provenance + supersede line) — rendered in the dialog via <Markdown>
  sub_issues: Vec<SubIssuePreview>,   // one per finding, in the deterministic order
  total: u32,
  groups: Vec<GroupCount>,    // { label, count } — deterministic grouping/counts for the dialog chips
  supersedes: Option<PriorMap>,       // { number, title, url } if a prior nc:map for this kind is open
  soft_warning: Option<String>,       // Some("This will open 63 issues…") when total > SOFT_WARN (~50)
  narrative_ok: bool,         // false ⇒ the LLM pass fell open to deterministic text (surface a subtle note)
}

SubIssuePreview { title: String, group_label: String }   // title only in the preview (bodies are large)
GroupCount     { label: String, count: u32 }
PriorMap       { number: u64, title: String, url: String }
```

The **narrative strings** the LLM produced (exec summary + per-group intros) are threaded back to
the write command so the previewed bytes are exactly what posts (§3.8) — carry them on the
preview payload too (an `exec_summary: String` + `group_intros: Vec<GroupIntro { label, intro }>`
the confirm hands back), or (documented alternative, §3.8) cache the whole rendered `IssueMapPlan`
Rust-side under a preview token and pass only the token back.

### 3.2 The `gh` seam — issue create + native sub-issue attach

Every GitHub call rides the consolidated `gh` seam (`git/gh.rs`) run in the run's `project_path`
(so `{owner}/{repo}` resolve from origin — `run_gh_bounded` applies `scrub_git_env` so gh's inner
git is scrubbed, `git/gh.rs:130`). Two REST primitives + one attach, each **binary-parameterized**
(`_with(dir, binary, …)`) so tests inject a fake `gh` (the `post_issue_comment_with` fixture
pattern, `workflow/issue_triage/post.rs:184`). Payloads are built with `serde_json::json!` and
posted on **stdin via `--input -`** — never argv-interpolated (the PR-arc rule,
`pr_fix/comment.rs:94-99`).

1. **`create_issue(dir, title, body, labels) -> CreatedIssue { id: u64, number: u64, url: String }`**
   — `gh api --method POST repos/{owner}/{repo}/issues --input -` with
   `json!({ "title": …, "body": …, "labels": [ … ] })`. The response carries **both** `id`
   (internal database id) and `number` (public issue number) and `html_url` — capture **all
   three**. Labels are applied inline at create (the labels must already exist — ensured first,
   §3.7), so there is no separate `add_label` round-trip.

2. **`add_sub_issue(dir, parent_number, sub_issue_id)`** — `gh api --method POST
   repos/{owner}/{repo}/issues/{parent_number}/sub_issues --input -` with
   `json!({ "sub_issue_id": <child DB id> })`.
   **VERIFIED against the GitHub REST docs (2026-07-10):** the sub-issues add endpoint takes the
   **internal database `id`, NOT the issue `number`.** This is the load-bearing subtlety — the
   child's `number` is what shows in the URL and the parent's task-list, but the attach body wants
   the `id` returned by `create_issue`. Optional `replace_parent` is unused (each child is created
   fresh with no parent).

3. **`close_issue(dir, number, reason)`** (supersede path, §3.10) — `gh api --method PATCH
   repos/{owner}/{repo}/issues/{number} --input -` with `json!({ "state": "closed",
   "state_reason": "completed" })`; and list a parent's children via `gh api
   repos/{owner}/{repo}/issues/{n}/sub_issues` for the "close its open sub-issues" option.

**Failure parsing:** clone `map_post_failure` (`workflow/issue_triage/post.rs:140-167`) — `gh api`
prints GitHub's error JSON to **stdout** (stderr is only `gh: <status>`), so parse `errors[]`
first, fall back to top-level `message` (`:157-161`). All runs are deadline-bounded via
`run_gh_bounded` (`git/gh.rs:111`) so a black-holed GitHub errors out instead of pinning the
worker.

#### 3.2.1 Partial-failure & rollback — the multi-issue create is NOT a transaction

GitHub has no transaction. The map is created in this **strict order**, parent-first so the visible
artifact is always coherent:

```
1. ensure_labels(dir, needed)            # idempotent, cached (§3.7). A label 403 → degrade (§3.8).
2. parent = create_issue(parent_title, parent_body, [nc:map, nc:<kind>])
     ↳ FAILS  ⇒ nothing exists; return Err. Clean, no rollback needed.
3. for k in 0..N (SEQUENTIAL, never parallel — secondary-rate-limit safety, §3.9):
     child_k = create_issue(sub_title_k, sub_body_k, [nc:finding, nc:<kind>])
     add_sub_issue(parent.number, child_k.id)
     ↳ on ANY failure at step k: STOP. Do NOT delete anything.
```

**Rollback posture — best-effort forward, never destructive.** Issues cannot be truly deleted via
the API without admin, and silently deleting user-visible issues is surprising. So on a mid-run
failure the command **stops and returns a structured partial result**, never a rollback:

```
IssueMapResult {
  parent: PriorMap { number, title, url },   // the parent DID land — surface its link
  created: u32,          // sub-issues successfully created AND attached
  attempted: u32,        // = N
  failed_at: Option<u32>,// the finding index that failed (None ⇒ full success)
  partial: bool,
  error: Option<String>, // the mapped gh failure at failed_at
  degraded_linkage: bool,// true if native sub-issues were unavailable and we fell back (§3.2.2)
}
```

The UI then shows: *"Created map #N with X of Y findings; stopped at #Z: <error>. Open the map to
review; retry mints a fresh map."* No auto-retry (a retry is a fresh map per decision 4; the user
closes the partial one via the supersede flow). Because the parent is created first, a partial map
is always a real, browsable parent with the sub-issues that made it — never an orphan set of
children with no parent.

**Idempotency note:** an `add_sub_issue` re-attach of an already-attached child is tolerated
(GitHub no-ops / 422s the duplicate); the create step is the only non-idempotent one, and a retry
never re-uses a half-created run — it mints a fresh parent.

#### 3.2.2 Native-sub-issue-unavailable degradation (fail-open)

If the **first** `add_sub_issue` returns a 404/403 signature (`gh` stderr `HTTP 404`/`Not Found` /
`Resource not accessible`) — the sub-issues feature disabled for the repo, or the token lacks the
scope — degrade for the whole run (cache the downgrade, keyed by `project_path`) to a **task-list
linkage**: skip native attach and instead append a `- [ ] #<childNumber> <title>` checklist to the
parent body (GitHub renders task-list references as a lightweight relationship) and set
`degraded_linkage = true`. Sub-issue creation continues; the map is still coherent, just not
natively nested. This mirrors #97's degradation ladder (`§3.8` of the sync spec). A non-scope
failure (transient/timeout) is NOT a downgrade — it stops per §3.2.1.

> Because the parent body must carry the fallback checklist, build the parent body so the checklist
> can be **appended after** the children exist under degradation — either post the parent, then
> `PATCH` its body once the checklist is known, or (simpler) buffer child numbers and only create
> the parent after the children under degraded mode. **Chosen:** on first-attach-404, switch to
> "create all children, then create the parent with the checklist baked in" for the remainder —
> the parent is created LAST only in the degraded branch. In the happy (native) path the parent is
> always first.

### 3.3 The persisted-run reads (read-only, off the existing stores)

The export operates on a **completed** persisted run and never mutates it. Each scan kind resolves
its run + items exactly like its convert command does today:

- **Insight** — `InsightStore::get(run_id)` → `InsightRun.findings: Vec<StoredFinding>`
  (`store/insight.rs:174,55`); project root = `InsightRun.project_path` (the `gh` cwd). The convert
  precedent that reads a run + item and roots gh at `project_path` is `convert_finding_to_task`
  (`sidecar/insight.rs:162-214`).
- **Scorecard** — `ScorecardStore::get(run_id)` → `ScorecardRun.readings: Vec<StoredReading>`
  (`store/scorecard.rs:169,49`).
- **Enforce** — `HarnessStore::get(run_id)` → `HarnessRun.findings: Vec<StoredConventionFinding>`
  (`store/harness/wire.rs:400,26`) **+** `HarnessRun.coverage: Vec<StoredRuleCoverageGap>`
  (`wire.rs:432,229`, the new additive `coverage` field). Only the `conventions` half — the
  `proposals`/`artifacts` (Harden) are out (§1).

**Active-project guard:** require the run's `project_path` == the active project and use its root
as the `gh` cwd (the `require_project` + path-check idiom, `sidecar/issue_triage/convert.rs:73-78`).
Only findings with `status != "dismissed"` are exported (open + converted; dismissed findings are
noise). This is a read-only filter, not a lifecycle mutation.

### 3.4 Deterministic authoring — grouping, ordering, counts, provenance

**Home:** `workflow/issue_map/plan.rs`, pure over the loaded run (unit-testable with no gh, no
engine — the diff-budget/anti-gaming "pure over parsed records" posture). It produces an
`IssueMapPlan` = parent title + ordered groups + per-finding `{ title, body_inputs }`, from which
`render.rs` (§3.6) builds the markdown. Grouping/ordering/counts are a pure function of existing
fields (decision 3):

**(a) Insight** (`StoredFinding`): **group by `category`**, groups ordered by highest-severity-
first then group size; within a group order by `severity` (high → medium → low), tie-break
`effort` then `title`. Counts: total + per-category. Title-source `category`/`severity`/`effort`
are already wire strings on the finding.
- **Sub-issue title:** `finding.title` (sanitized). Optionally prefixed `[<category>] `.
- **Sub-issue body:** mirror `task_description` (`sidecar/insight.rs:227-263`) field selection —
  `description`, then a `**Category** · **Severity** · **Effort**` line, `location` as a code-span
  `file:line`, `rationale`, `suggestion`, the before/after code diff, `affected_files` — **but
  rendered GitHub-safe** (§3.6), i.e. **without** the `untrusted_block` prompt fence (that fence is
  for feeding text INTO an agent; on a GitHub body it renders as `<analysis-finding>` noise —
  `infra/untrusted.rs:20-28`). Provenance footer: `_From Nightcore Insight run <runId>._`.

**(b) Scorecard** (`StoredReading`): **group by `dimension`**; groups ordered worst-grade-first;
within a group order by `grade` (F → A). Counts: total + a grade histogram (per-dimension grade).
- **Sub-issue title:** `<dimension> — <title>` (or `[<grade>] <title>`).
- **Sub-issue body:** `summary`, a `**Dimension** · **Grade**` line, `rationale`, `location`,
  `suggestion`, then the `findings: Vec<ScorecardEvidence>` as an evidence list (each `detail`
  + code-span `location`, `store/scorecard.rs:36`), `affected_files`.

**(c) Enforce** (`StoredConventionFinding` + `StoredRuleCoverageGap`): **one sub-issue per
convention finding**; coverage is **folded in**, not a separate sub-issue (the dedup rule below).
**Group by coverage `status`** — `unenforced` first, then `documented-only`, then `enforced` (the
gaps lead). Counts: total conventions + per-status coverage histogram.
- **Coverage join / dedup:** a `StoredRuleCoverageGap` joins its convention by
  `coverage.convention_fingerprint == finding.fingerprint` (`wire.rs:231`). Build a
  `HashMap<fingerprint → &StoredRuleCoverageGap>` once; each convention sub-issue folds in its
  coverage line (`status`, `enforced_by` rule ids, `documented_in` claims,
  `suggested_artifact_kind`). This avoids emitting a duplicate sub-issue for the same convention.
  **Orphan coverage** (a coverage record whose `convention_fingerprint` matches no exported
  finding) is rare (recomputed each scan) — emit it as its own lightweight sub-issue under the
  matching status group, or drop it (implementer's call; test both branches don't double-count).
- **Sub-issue title:** `finding.title`.
- **Sub-issue body:** `description`, a `**Category** · **Kind** (convention|gap) · **Severity**`
  line, the folded **Coverage** line, `evidence: Vec<FindingLocation>` as code-span anchors,
  `rationale`, `suggestion`.

**Parent provenance (locked):** every parent body ends with a provenance block — scan **kind**,
**runId**, **ISO timestamp** (`generated_at`), model, and the deterministic **counts** table.
The ISO timestamp is minted once at preview and threaded through (§3.8) so preview == post; a
small `format_utc_datetime(epoch_ms)` helper extends the civil-from-days `format_utc_date`
(`workflow/issue_triage/post.rs:25-38`, date-only) with a `T00:00:00Z`-style time, or the run's
`created_at` is rendered directly. Deterministic — never reads the clock twice.

### 3.5 The LLM narrative pass — home + fail-open (RECOMMENDED: the `claude -p` one-shot)

**Recommended home: `workflow/oneshot.rs::run_oneshot`** (the shared `claude -p --model haiku`
core), wrapped by a new `workflow/issue_map/narrative.rs` that mirrors `commit_msg.rs` /
`pr_msg.rs` (its two existing callers). **Not** the engine synthesis seam.

**Why (grounded in code):**
- **Fail-open by construction** (satisfies decision 3). `run_oneshot` collapses *every* failure —
  no `claude` on PATH, non-zero exit, timeout, empty output — to `None`
  (`workflow/oneshot.rs:60-62,192-203`), and the caller substitutes deterministic text. The engine
  synthesis seam needs a live sidecar session and has no such trivial fail-open.
- **Least privilege for partly-untrusted input.** The narrative pass is fed finding *titles* +
  the deterministic group summary — repo/model-derived text. `run_oneshot` disallows **all** tools
  (mutation AND read/network) and suppresses MCP (`oneshot.rs:157-174`), so a prompt injection in a
  finding title cannot read local secrets or exfiltrate — it gets only its stdin. That is exactly
  the threat model here.
- **Low latency, no dependency.** Haiku, single shot, 30s hard bound (`oneshot.rs:38`); no engine
  boot, no session lifecycle. The pass is cosmetic (exec summary + intros), so a haiku round-trip
  is the right weight.
- **The arg-order gotcha is already handled** inside `run_oneshot_with` (the positional prompt
  precedes the variadic `--disallowed-tools`, `oneshot.rs:152-156`) — the narrative caller never
  touches argv.

**Shape (clone `commit_msg.rs`):** `narrative.rs::generate(plan: &IssueMapPlan) -> Narrative`
builds a stdin payload — the deterministic group summary + finding titles, clearly delimited like
`build_payload` (`commit_msg.rs:60-77`) — with a fixed instruction ("write a 2-3 sentence
executive summary and a one-line intro per group; output JSON `{summary, intros: {label:…}}`; no
preamble/fences"), calls `run_oneshot`, then `sanitize` via `strip_code_fence` + `cap`
(`oneshot.rs:208,222`). On `None` OR unparseable output, return the **deterministic** `Narrative`
(a templated summary like "24 findings across 6 categories; 8 high-severity." + per-group intros
naming the count/severity). `IssueMapPreview.narrative_ok` records which branch ran. The narrative
strings are still rendered GitHub-safe (§3.6) — they are semi-untrusted.

### 3.6 Untrusted-content rendering — REUSE the trust fence helpers (do not duplicate)

Finding titles/descriptions/paths/commands are repo/agent-derived and can carry adversarial text
(backticks, ``` fences, control chars). This lands on GitHub, so every untrusted span is fenced
exactly as the Trust Report does. **The helpers already exist in `workflow/trust/render.rs`
(PR #113):** `code_span` (control chars → spaces + whitespace collapse via
`crate::task::sanitize_minted_title`, then a backtick run strictly longer than any inside it — the
`defuse_fence` idea) and `longest_backtick_run`, plus `sanitize_label`/`one_line` for prose.

**Reuse mechanism (small refactor, PR 1):** `code_span`/`longest_backtick_run` are `pub(super)` in
`trust/render.rs` today. **Lift the two fence primitives + `sanitize_label`/`one_line` into a
neutral shared home** — new `apps/desktop/src-tauri/src/workflow/github_md.rs` — that BOTH
`trust/render.rs` and `issue_map/render.rs` import. This honors "reuse, don't duplicate" without a
cross-feature dependency into `trust`. The trust module is already on `main` by the time export
builds (decision 5), so this is a one-file extraction + two import updates, not a coordination
hazard. (Alternative, documented-not-chosen: promote the two fns to `pub(crate)` in place and
`use crate::workflow::trust::render::code_span` — rejected: it couples `issue_map` to `trust`.)

`render.rs` for the map is otherwise a straight clone of `trust/render.rs`'s posture: a house
GitHub header (`### 🌙 Nightcore …`) + a `_Posted from Nightcore._` footer
(`trust/render.rs` `GH_HEADER`/`GH_FOOTER`; the same idiom as `compose_push_comment`,
`pr_fix/comment.rs:37,71-73`), untrusted spans through `code_span`, prose through `one_line`. The
prompt-only `untrusted_block` (`infra/untrusted.rs`) is **never** used on the GitHub path.

A `SUMMARY_MAX_CHARS`-style body cap (GitHub's issue-body limit is 64K; clone
`pr_fix/comment.rs:26,60-67`) guards a runaway finding body.

### 3.7 Labels — ONE shared `nc:*` vocabulary, ensure-at-use (export creates the home)

Export ships **before** #97 (decision 5), so it **creates** the shared label home #97 extends.

**Home:** `workflow/github_labels.rs` (a neutral peer both features import) — the `ensure_label` /
label-color constants live here, cloned from the #97 sync spec's `issue_sync/labels.rs` design
(itself a clone of `post_issue_comment_with`'s injection-safe posture). When #97 lands it adds its
five **status** labels (`nc:queued`…`nc:failed`) to this same table — ONE vocabulary, one
`ensure_label` primitive. Flag this in the PR body so #97 imports rather than re-defines.

**The labels export needs (all `nc:*`, fixed colors/descriptions):**

| Label | Color | Role | Addition? |
|---|---|---|---|
| `nc:map` | `5319e7` | A Nightcore scan-map parent issue | **NEW** (flagged) — also the supersede-discovery key |
| `nc:finding` | `bfd4f2` | A Nightcore scan-finding sub-issue | **NEW** (flagged) |
| `nc:insight` | `0e8a16` | From an Insight scan | **NEW** per-scan-kind (flagged) |
| `nc:scorecard` | `fbca04` | From a Scorecard scan | **NEW** per-scan-kind (flagged) |
| `nc:enforce` | `d93f0b` | From an Enforce/conventions scan | **NEW** per-scan-kind (flagged) |

**Why the per-scan-kind labels are more than cosmetic (the flag, answered):** they are the
**discovery mechanism** for decision 4's supersede. With no local persistence of map issue numbers,
the prior map for a project+kind is found by `gh issue list --label nc:map --label nc:<kind>
--state open` (§3.10). Without a per-kind label, an Insight re-export couldn't tell an Insight map
from a Scorecard map. So these labels earn their keep; they are still flagged here as additions to
the #97 vocabulary for the reviewer's sign-off.

**Ensure-at-use:** `ensure_label(dir, name, color, desc)` — `gh api repos/{owner}/{repo}/labels
--method POST -f name=… -f color=… -f description=…`, tolerating HTTP 422 `already_exists` as
success (idempotent create), **cached** in an `OnceLock<Mutex<HashSet<(project_path, name)>>>` so
steady-state exports skip the ensure call (the #97 `issue_sync/labels.rs` cache design). Ensure
runs once up front for the ≤5 distinct labels a map uses, before any `create_issue` (labels are
applied inline at create, §3.2). A label 403 degrades (§3.8): create issues **without** labels
rather than failing the export.

### 3.8 Preview == post (the human-gate guarantee) + the write command's trust boundary

The locked default requires a full preview whose bytes are what posts. Everything deterministic
(structure, counts, sub-issue titles/bodies, provenance) is **re-derived Rust-side from the run**
in both the preview and write commands — never accepted from the web. The only non-deterministic
content is the LLM **narrative** (exec summary + group intros). To keep preview == post:

- The **preview command** runs the deterministic plan + the one LLM pass, mints `generated_at`
  once, and returns `IssueMapPreview` (§3.1) including the narrative strings.
- The **write command** re-derives the deterministic plan from the run, re-mints nothing, and
  takes back only: `run_id`, `scan_kind`, the **narrative strings**, and the **`generated_at`** the
  preview showed. It treats the narrative strings as **untrusted** and runs them through
  `one_line`/`code_span` (§3.6) before interleaving them at the same deterministic slots. So the
  posted parent body is byte-identical to the previewed one, and the only web-supplied bytes are
  the (sanitized, already-previewed) prose — never structure. This mirrors `build_issue_comment_body`
  taking `validated_date` as a param for determinism (`issue_triage/post.rs:56,289`).
- **Documented alternative (not chosen):** the preview command caches the fully-rendered
  `IssueMapPlan` Rust-side under a short-lived `preview_token`, and the write command passes only
  the token — zero web-supplied bytes. Rejected for v1: it adds transient server state and a
  token-expiry story for a cosmetic prose difference; the sanitize-on-write path is simpler and the
  narrative is fail-open low-stakes text.

### 3.9 Volume, rate-limits, single-flight

- **Sequential creation** (§3.2.1) — never parallel. GitHub's *secondary* rate limit throttles
  rapid content creation; a serial loop on the single blocking worker is the safe cadence. The
  soft ~50 warning (`soft_warning`, §3.1) also bounds how many issues a single confirm opens.
- **Budget:** ≈ `1 (parent) + 2·N (create + attach per finding) + ≤5 (ensure_label)` REST calls.
  50 findings ≈ 105 calls — negligible against the 5000/hr authenticated budget; the secondary
  limit (not the primary) is the real ceiling, hence serial + the soft warning.
- **Single-flight — NOT the root mutation lease.** Guard concurrent exports of the same run with a
  dedicated `issue_map_in_flight` set keyed by `run_id` (clone `TaskLease`,
  `workflow/merge/lease.rs:40-53`). **Do NOT** acquire `acquire_root_lease` (`lease.rs:82`):
  issue/sub-issue creation is a pure GitHub-API operation that never touches the working tree or
  index, so it cannot collide with merge/commit — and a minutes-long root-lease hold across ~100
  calls would needlessly refuse every concurrent merge/commit. This is a deliberate **deviation**
  from the issue_triage-comment precedent (which acquires the root lease for its single write); it
  is called out in §10.

### 3.10 Re-export — supersede by label, offer-to-close (decision 4, no persistence)

No map issue number is persisted locally. The prior map for a project+kind is **re-discovered by
label** at preview time:

- `gh issue list --label nc:map --label nc:<kind> --state open --json number,title,url` (or the
  `gh api` search equivalent) in `project_path`. The newest result is the prior map →
  `IssueMapPreview.supersedes = Some(PriorMap { … })`.
- **On the new parent:** the deterministic parent body includes `_Supersedes #<N>._` when a prior
  map exists.
- **Offer to close the old map:** the preview dialog shows a checkbox *"Close the superseded map
  #N and its open sub-issues."* When checked, after the new map lands the write command (or a thin
  follow-up `close_superseded_map(project_path, old_parent_number)`) lists the old parent's
  children (`GET …/issues/{n}/sub_issues`) and closes each open child + the parent via
  `close_issue` (§3.2). Human-gated (the checkbox), best-effort (a close failure is a surfaced
  warning, not an export failure). No fingerprint diffing — the whole prior map is closed, the
  whole new map is fresh (decision 4).

### 3.11 Rust module home + thin commands

**Per the backend-decomposition layer discipline** (the flow composes store readers + the gh seam
+ the one-shot, so it is a `workflow/` flow, not a `store/` leaf):

- `apps/desktop/src-tauri/src/workflow/issue_map/` — `mod.rs` (facade), `contract.rs` (§3.1 ts-rs
  types), `plan.rs` (§3.4 deterministic authoring), `narrative.rs` (§3.5 LLM pass), `render.rs`
  (§3.6 markdown, importing `workflow/github_md.rs`), `post.rs` (§3.2 gh create/attach/close +
  partial-failure), `tests.rs`. A peer of `workflow/issue_triage/`, `workflow/trust/`,
  `workflow/pr/`.
- `apps/desktop/src-tauri/src/workflow/github_md.rs` — the shared fence/sanitize helpers lifted
  from `trust/render.rs` (§3.6).
- `apps/desktop/src-tauri/src/workflow/github_labels.rs` — the shared `nc:*` ensure-at-use seam
  (§3.7).
- **Thin commands** in `sidecar/issue_map.rs` (peer of `sidecar/insight.rs` /
  `sidecar/issue_triage/`), each **async + `spawn_blocking`** (they shell to `gh` — the sync-command
  WKWebView-freeze trap, `reference_tauri_command_threading`):
  - `preview_issue_map(scan_kind, run_id) -> IssueMapPreview` — resolve run + project guard, build
    the plan, run the LLM pass, discover the prior map, return the payload. Runs the one gh **read**
    (prior-map list) + the one `claude -p`.
  - `export_issue_map(scan_kind, run_id, generated_at, narrative, close_superseded: bool) ->
    IssueMapResult` — the `issue_map_in_flight` single-flight, ensure labels, create parent, loop
    create+attach (§3.2.1), optional supersede-close (§3.10). Emits an `nc:issue-map` progress
    event (`created k / N`) so the dialog shows progress; the return is the terminal result.
  - Register both in `lib.rs`'s `generate_handler!` (`lib.rs:182`) beside the scan commands
    (`:214-241`).

### 3.12 Web surface — the export action (SIBLING to convert-all) + the preview dialog

**Placement — a SIBLING affordance beside the existing convert affordances in each results view:**

- **Insight** — the completed-results action bar at `InsightView.tsx:181-211` already hosts
  *"Convert all to tasks (N)"*. Add an **"Export to GitHub"** button as its sibling in that bar.
- **Enforce/Harness** — the `conventions` section (`HarnessView.tsx:197-207`, `ConventionGrid` +
  `RuleCoverageGaps`). Add an **"Export to GitHub"** button in a header bar above the grid (the
  proposals section already has a convert-all bar at `:213-218` — mirror its shape for conventions).
- **Scorecard** — the results screen (`ScorecardView.tsx:128-152`) currently has **no** action bar
  (just `DimensionGrid`). Add a small results header bar hosting **"Export to GitHub"**.

> **⚠️ Coordination with `feat/convert-all-parity` (flag for the map builder).** A parallel builder
> is adding **convert-all** buttons to these same three views' results bars — including a NEW bar
> in `ScorecardView` (which has none today). Design the export button as a **sibling in the same
> bar**, not a new bar, and **rebase onto `feat/convert-all-parity` before wiring the web PR** so
> both actions share one action-bar container. If that branch has not merged when the map web PR
> starts, put the export button in its own minimal bar and leave a `// TODO(convert-all-parity):
> merge into the shared results action bar` note. The Rust PR (PR 1) is independent of this branch.

**The preview dialog — clone `CreatePRDialog`** (`worktree/CreatePRDialog/`, the full-preview-then-
confirm `<Modal>` gate):
- New `apps/web/src/components/issuemap/IssueMapDialog/` (folder-per-component, ≤400-line ratchet;
  the parent-body preview, the sub-issue-title list, and the confirm footer are separate
  sub-components if the file grows).
- Body: the parent markdown rendered via the existing `<Markdown>` component
  (`components/ui/Markdown`), the deterministic group-count chips, the **full list of sub-issue
  titles**, the `supersedes #N` + *"close the old map"* checkbox when present, and the
  `soft_warning` banner when `total > 50`.
- Confirm footer states exactly what will happen (*"Open 1 parent + N sub-issues on
  owner/repo"*). **Enter is NOT wired to confirm** (irreversible GitHub write — clone
  `CreatePRDialog`'s explicit-click rule, `CreatePRDialog.tsx:20-28`). Every close affordance routes
  through a submitting-aware `requestClose` so a mid-export Esc/backdrop can't unmount the dialog.
- Progress: consume the `nc:issue-map` progress event to show *"Creating… k/N"*; on the terminal
  `IssueMapResult` show success (link to the parent) or the partial-failure notice (§3.2.1).
- **Plumbing:** bridge wrappers in new `apps/web/src/lib/bridge/commands/issue-map.ts`
  (`previewIssueMap` / `exportIssueMap`, no-op outside Tauri — the `issues.ts`/`insight.ts`
  wrapper idiom). The dialog is opened from each view's export button; the export is a SIBLING of
  convert — it mints **no task** and dispatches **no** convert/`sourceRef` action.

---

## 4. Constraints carried (do not violate)

1. **Zero new persistence / instrumentation.** No new `.nightcore/` layout, no new store, no new
   event except the transient `nc:issue-map` progress emit. Scan runs are read verbatim, read-only.
   Map issue numbers are re-discovered by label (§3.10), never stored.
2. **Orthogonal to convert-to-task.** No task minted, no `sourceRef` written, the shared convert
   protocol (`sidecar/convert.rs`) is untouched, the 6 mint prefixes are frozen.
3. **Human-gated full preview.** No GitHub write before the confirm; Enter never confirms; preview
   bytes == posted bytes (§3.8).
4. **Untrusted finding text** → the shared `code_span`/fence + control-char sanitize (§3.6), NOT
   the prompt-only `untrusted_block`.
5. **Target repo = origin of the run's `project_path`.** `{owner}/{repo}` resolve via `gh` in that
   cwd — never a raw URL over IPC (§3.2).
6. **Partial failure is best-effort forward, never destructive** (§3.2.1) — no issue is ever
   deleted; a stopped export returns a structured partial result.
7. **`gh` argv hygiene** — labels are our own `nc:*` constants; issue numbers are `u64` decimal;
   every body/field rides `--input -` / `-f k=v`, never a shell-interpolated string; `gh` runs
   under `scrub_git_env` (`git/gh.rs:130`). Nightcore stores no token — `gh` owns auth.
8. **Labels share the #97 vocabulary** (§3.7); additions are flagged; a label-scope 403 degrades
   (create without labels), never crashes.

---

## 5. Codegen / lint lockstep checklist

| Concern | File | PR | Action |
|---|---|---|---|
| ts-rs export registration | `bindings/export.rs:74` (the `export!` block) | 1 | Register `IssueMapPreview` + nested (`SubIssuePreview`/`GroupCount`/`PriorMap`) beside `InsightRun`/`ScorecardRun`. `cargo test` regenerates `apps/web/src/lib/generated/*`. Never hand-edit. |
| Command registration | `lib.rs:182` `generate_handler!` | 1/2 | Add `sidecar::issue_map::{preview_issue_map, export_issue_map}` beside the scan commands (`:214-241`). |
| Shared fence helpers | `workflow/trust/render.rs` → new `workflow/github_md.rs` | 1 | Lift `code_span`/`longest_backtick_run`/`sanitize_label`/`one_line`; update `trust/render.rs` imports (the trust module is on `main` — verify `cargo test` for `trust` still green). |
| Shared label seam | new `workflow/github_labels.rs` | 1 | Owns `ensure_label` + `nc:*` constants; note in the PR body that #97 extends it (does not re-define). |
| Reuse existing generated types | `store/{insight,scorecard,harness}` | 1 | Read `Stored*` verbatim in `plan.rs`; do not re-model. |
| Web folder-per-component | `packages/eslint-plugin/` | 2 | `issuemap/IssueMapDialog/` must satisfy `component-folder-structure` / thin-shell / hook-budget. `bun run lint`. |
| lint-meta | `tools/lint-meta/` | 1-2 | No new lint-meta rule: `IssueMapPreview` is not a `source-ref.ts` REGISTRY view (no nav-render-parity) and not a scan family (no scan-family-parity). Validate `bun run lint:meta` = 0 on a clean tree. |
| No new `nightcore/*` ESLint rule | `tools/lint-meta/rules/agent-contract-parity.ts` | — | Unaffected — do not wire a new ESLint rule (avoids the AGENTS.md-parity trap). |

---

## 6. Field-mapping reference (per scan kind → sub-issue title/body)

| Kind | Type (file:line) | Sub-issue title | Body fields (GitHub-safe, §3.6) | Group key / order | Dedup note |
|---|---|---|---|---|---|
| Insight | `StoredFinding` (`store/insight.rs:55`) | `title` (opt. `[category]`) | `description`; `category`·`severity`·`effort`; `location` (code-span `file:line`); `rationale`; `suggestion`; before/after diff; `affected_files` | group `category`; order severity high→low | `id` unique; export `status != dismissed` |
| Scorecard | `StoredReading` (`store/scorecard.rs:49`) | `<dimension> — <title>` | `summary`; `dimension`·`grade`; `rationale`; `location`; `suggestion`; `findings` (`ScorecardEvidence` detail+location, `:36`); `affected_files` | group `dimension`; order grade F→A | `id` unique |
| Enforce | `StoredConventionFinding` (`harness/wire.rs:26`) + `StoredRuleCoverageGap` (`:229`) | `title` | `description`; `category`·`kind`(convention\|gap)·`severity`; **folded coverage** (`status`, `enforced_by`, `documented_in`, `suggested_artifact_kind`); `evidence`; `rationale`; `suggestion` | group coverage `status` (unenforced→documented-only→enforced) | coverage joins finding by `convention_fingerprint == fingerprint`; fold in, do NOT emit twice; orphan coverage → own sub-issue or drop |

The Insight body mirrors `task_description` (`sidecar/insight.rs:227-263`) **minus** the
`untrusted_block` prompt fence; the Enforce/Scorecard bodies mirror the same field-selection style.

---

## 7. PR slicing (implement one at a time; each independently green)

Staged like the house waves: PR 1 lands the Rust plan + preview/post + gh + labels + shared
helpers (fully headless-testable); PR 2 wires the web dialog + the three export buttons + the
narrative preview. PR 2 depends on PR 1.

### PR 1 — Rust: plan + render + gh post + labels + preview/export commands

- **Scope:** new `workflow/issue_map/` (`mod.rs`, `contract.rs`, `plan.rs`, `narrative.rs`,
  `render.rs`, `post.rs`, `tests.rs`); new `workflow/github_md.rs` (fence helpers lifted from
  `trust/render.rs`, imports updated) + `workflow/github_labels.rs` (ensure-at-use `nc:*`);
  `sidecar/issue_map.rs` with `preview_issue_map` + `export_issue_map`; ts-rs registration in
  `bindings/export.rs`; `generate_handler!` wiring in `lib.rs`.
- **Encodes:** deterministic authoring per kind (§3.4), the LLM fail-open narrative (§3.5), the
  GitHub-safe rendering reuse (§3.6), issue+native-sub-issue create with partial-failure + linkage
  degradation (§3.2), ensure-at-use labels (§3.7), preview==post (§3.8), the `run_id` single-flight
  (§3.9), supersede-by-label (§3.10).
- **Green because:** additive module + additive commands + a one-file helper extraction; all gh is
  fake-`gh`-tested (no live network); `cargo test` regenerates + commits the ts-rs output (new,
  unused TS is web-typecheck-neutral); no existing behavior touched except the `trust/render.rs`
  import swap (covered by the existing trust tests). `bun run lint`/`lint:meta`/web are no-ops.

### PR 2 — Web: preview dialog + the three export buttons + narrative-in-preview

- **Scope:** `apps/web/src/components/issuemap/IssueMapDialog/` (folder-per-component); bridge
  wrappers in `lib/bridge/commands/issue-map.ts`; the **"Export to GitHub"** sibling button in
  `InsightView` (`:181-211`), `HarnessView` conventions section (`:197-207`), and a results header
  bar in `ScorecardView` (`:128-152`); the `<Markdown>` parent-body preview + sub-issue-title list +
  supersede checkbox + soft-warning banner + progress consume of `nc:issue-map`.
- **Encodes:** the human-gated full preview (locked default) with Enter-never-confirms; the
  sibling-to-convert placement (§3.12).
- **Green because:** additive UI (folder-per-component satisfies the ESLint plugin) over existing
  PR-1 commands; `bun run lint`, web typecheck/test, cargo test all pass. **Rebase onto
  `feat/convert-all-parity` first** so the export button shares the results action bar (§3.12).

---

## 8. Test plan (clone the named idioms; every file already exists)

1. **Plan — pure over synthetic runs** (`workflow/issue_map/tests.rs`, PR 1). Build synthetic
   `InsightRun`/`ScorecardRun`/`HarnessRun` (clone the store test builders,
   `store/insight.rs:357-395`, `store/scorecard.rs:334-369`, `store/harness/mod.rs:41-135`). Assert:
   Insight groups by category ordered severity-first; Scorecard groups by dimension ordered grade
   F→A; Enforce folds coverage into the matching convention (join by `convention_fingerprint`) and
   never double-counts; dismissed findings are excluded; counts match.
2. **Renderer golden-ish** (`tests.rs`, PR 1). Assert a sub-issue body contains its `title`,
   location code-span, and the provenance footer; assert an untrusted title with a backtick /
   control char / newline is neutralized into a single safe code span (clone the
   `sanitize_minted_title`/`code_span` assertions from the trust renderer tests / `trust/render.rs`
   §3.6); assert the parent body carries kind + runId + ISO timestamp + counts + `Supersedes #N`
   when a prior map is passed; assert the GitHub header/footer.
3. **Narrative fail-open** (`narrative.rs` tests, PR 1). With a fake one-shot binary
   (`run_oneshot_with`, `oneshot.rs:146`) returning empty/garbage/non-zero, assert the deterministic
   `Narrative` is used and `narrative_ok == false`; with valid JSON, assert it parses + sanitizes
   (clone the `commit_msg.rs` sanitize tests, `:108-133`).
4. **gh create + attach + partial failure** (`post.rs` tests, PR 1). Fake-`gh` script (the
   `post_issue_comment_with`/`create_pr_with` fixture pattern, `issue_triage/post.rs:225`): assert
   `create_issue` POSTs `title`/`body`/`labels` and parses BOTH `id` and `number`; assert
   `add_sub_issue` posts `{"sub_issue_id": <id>}` (the **id, not number**) to
   `…/issues/{parent}/sub_issues`; assert a failure at child k returns `IssueMapResult { partial:
   true, failed_at: Some(k), created: k }` and deletes nothing; assert a first-attach-404 degrades
   to task-list linkage (`degraded_linkage: true`) and keeps going.
5. **Labels ensure-at-use** (`github_labels.rs` tests, PR 1). Fake `gh`: `ensure_label` tolerates
   422 as success and caches; a label 403 → export creates issues without labels (degrade), never
   errors.
6. **Supersede discovery** (`post.rs` tests, PR 1). Fake `gh issue list --label nc:map --label
   nc:<kind>` returning one open map → `supersedes` set; empty → `None`; the close-old path lists +
   closes children + parent only when the checkbox flag is set.
7. **preview == post** (`tests.rs`, PR 1). Assert the parent body the write command renders (given
   the same run + narrative + `generated_at`) is byte-identical to the preview's `parent_body`
   (clone the `body_is_deterministic_for_a_given_date` guarantee, `issue_triage/post.rs:289`).
8. **Dialog render + gate** (`IssueMapDialog.test.tsx` + `.stories.tsx`, PR 2). Stories for
   insight / scorecard / enforce / supersede-present / >50-warning / partial-failure. Test: Enter
   does NOT confirm; the confirm invokes `exportIssueMap`; the sub-issue-title list renders; the
   supersede checkbox threads `close_superseded`. Clone the `CreatePRDialog.test.tsx` conventions.
9. **View buttons** (`InsightView`/`HarnessView`/`ScorecardView` tests, PR 2). Assert the "Export
   to GitHub" button appears in the completed-results bar as a sibling of convert and opens the
   dialog; assert it mints no task / dispatches no convert action.

---

## 9. Verification gates (run per PR)

```
bun run lint                              # eslint-plugin (folder-per-component on IssueMapDialog/)
bun run lint:meta                         # lint-meta; zero violations on a clean tree
bun run --filter @nightcore/web typecheck # root `tsc -b` does NOT cover apps/web
bun run --filter @nightcore/web test      # PR 2 web tests
cargo fmt --all --check                   # MUST run from apps/desktop/src-tauri — root has no Cargo.toml
cargo clippy --all-targets                # from apps/desktop/src-tauri
cargo test                                # PR 1 regenerates ts-rs (IssueMapPreview) — commit the regen; runs plan/render/gh/label/narrative tests + re-runs trust tests after the helper lift
bun run dogfood:ui                        # manual: export button → preview dialog → (dry) confirm shows the parent + sub-issue titles; Enter does not confirm
```

- **PR 1** is the only PR with a real ts-rs regen (the `IssueMapPreview` bindings) — commit
  `apps/web/src/lib/generated/*`; never hand-edit. It also touches `trust/render.rs` imports (the
  `github_md.rs` lift) — the existing `workflow/trust` tests are the guard that the extraction is
  behavior-preserving.
- **Manual dogfood (deferred to the end, like the PR arc):** on the Nightcore repo, run an Insight
  scan → Export to GitHub → confirm a parent `nc:map`+`nc:insight` issue appears with N native
  sub-issues; re-export → confirm `Supersedes #N` + the offer to close the old map; revoke label
  scope → confirm the no-labels degrade; disable sub-issues on a scratch repo → confirm the
  task-list linkage fallback.

---

## 10. Existing-code contradictions / refinements found (surface, don't silently absorb)

1. **The native sub-issue attach takes the internal `id`, NOT the issue `number`.** Verified
   against the GitHub REST docs (2026-07-10): `POST …/issues/{n}/sub_issues` wants
   `{"sub_issue_id": <database id>}`. The `number` (shown in URLs, autolinks, the parent task-list)
   is a *different* integer. `create_issue` MUST capture both `id` and `number` from the create
   response; using `number` where `id` is expected silently attaches the wrong (or no) issue.
   Encoded in §3.2 + tested in §8.4.

2. **The map export does NOT need the root mutation lease — deliberate deviation.** The
   issue_triage comment post acquires `acquire_root_lease` for its single GitHub write
   (`sidecar/issue_triage/convert.rs:82`), and #97 acquires it per label transition. But issue /
   sub-issue creation is a pure GitHub-API operation that never touches the working tree or index,
   so it cannot collide with merge/commit, and holding the root lease across ~100 sequential calls
   for a large map would needlessly refuse every concurrent merge/commit for minutes. Export
   therefore uses a **dedicated `issue_map_in_flight` single-flight keyed by `run_id`** (§3.9),
   not the root lease. Flagged because it diverges from the "every GitHub mutation takes the root
   lease" mnemonic — the divergence is correct (no working-tree mutation), but a reviewer should
   sign off.

3. **Export ships before #97, so it OWNS the shared `nc:*` label home.** The #97 sync spec places
   the ensure-label seam in `issue_sync/labels.rs`. Since export lands first (decision 5), it
   creates the neutral shared home `workflow/github_labels.rs`; #97 must **extend** it (add the five
   status labels) rather than re-define a parallel seam. Flagged so the #97 implementer imports the
   shared home — otherwise the two features drift into two `ensure_label` copies and two color
   tables.

4. **The `feat/convert-all-parity` branch is racing the same three results bars.** It adds
   convert-all buttons — including a brand-new action bar in `ScorecardView` (which has none today,
   `ScorecardView.tsx:128-152`). The export button must be a **sibling in the same bar**. Rebase the
   web PR (PR 2) onto that branch before wiring, or leave a merge-into-shared-bar TODO. The Rust PR
   (PR 1) is independent. Flagged so the map builder budgets the rebase and both actions don't ship
   as two competing bars.

5. **`workflow/trust/render.rs`'s fence helpers are `pub(super)` — reuse needs a lift, not an
   import.** The locked default says reuse the PR-#113 helpers, but `code_span`/`longest_backtick_run`
   are module-private to `trust`. Rather than couple `issue_map` into `trust` (or duplicate the
   ~30 lines), PR 1 lifts them into `workflow/github_md.rs` (§3.6). This is the smallest honest
   "reuse, don't duplicate." Flagged as a (tiny) touch to an already-merged module so it's a
   conscious extraction, verified by the existing trust tests.

6. **`generated_at` must be minted once (preview) and threaded to post** — otherwise the preview's
   ISO timestamp differs from the posted one and the "full preview == what posts" guarantee breaks
   for the provenance line. Encoded as a write-command parameter (§3.8), mirroring
   `build_issue_comment_body(validated_date)`. Flagged because the naive "read the clock in both
   commands" approach silently violates the locked full-preview default.
