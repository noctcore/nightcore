# Build spec: Trust Report (per-task governance receipt)

**Date:** 2026-07-10
**Ticket:** wayfinder #91 (Trust Report) — realizes competitive-landscape opportunity #2
("Ship a 'Trust Report' per merged task"), `docs/research/2026-07-10-competitive-landscape.md:178-185`.
**Status:** build-ready. Every decision below is locked (grilled 2026-07-10 on issue #91). Do
NOT re-litigate; implement. The one deliberate OPEN QUESTION is the single named capture gap in § 6.
**Prior art (read for context, not for decisions):**
`docs/research/2026-07-10-competitive-landscape.md` (opportunity #2 + the "no competitor can
show this" framing), `docs/research/2026-07-10-terminal-build-spec.md:37-39` (the terminal's
scrollback is explicitly excluded from any future export/Trust-Report surface — honor it).

> An implementer with no session context can run **PR 1** directly from § 7. Each PR is
> independently green against all four gates (rust / node / web / plugin, § 8).

---

## 1. What this is (and is NOT)

The Trust Report is an **aggregation + rendering feature over instrumentation that already
exists**. Every selected content source is already captured on disk today:

- **Gauntlet + reviewer verdict** → persisted on the `Task` (`store/task/model.rs`):
  `structure_lock_result` (`:294-295`) already absorbs the entire deterministic battery
  (structure-lock checks + anti-gaming + contract-budget + strictness-ratchet + task
  verify-command, each a `StructureLockCheck` with `kind`/`name`/`command`/`status`/
  `exit_code`/`output`), and the reviewer verdict lives as `verified` (`:277`) + `review`
  (`:282`, full verdict text) + `fix_attempts` (`:287`).
- **Guardrail events** → the flight-recorder **ledger**, per-task append-only NDJSON at
  `.nightcore/ledger/<task_id>.ndjson` (`store/ledger.rs:37-41`). Every PreToolUse decision
  (`allow`/`deny`/`ask` + `ruleId`) is one record (`store/ledger.rs:46-68`), spanning the
  build/reviewer/fix sessions of the task.
- **Flight-recorder summary** → the same ledger (files touched = Write/Edit path digests;
  commands run = Bash command digests; session count = `session-start` markers) plus the
  per-task transcript (`store/transcript.rs`) for cost/token totals.

It is therefore **computed on demand from those stores — zero new persistence, zero new
instrumentation**. The `TrustReport` is a transient value minted per request, never written to
`.nightcore/`. The only additive touches are three *reader* changes (parse an already-written
`ts` field, count already-written `session-start` markers, and a full-file transcript summer) —
none of which adds a writer or changes any on-disk layout. § 6 names the single genuine capture
gap and its smallest additive fix, clearly marked as this spec's only open question.

**Injection-quarantine events are OUT for v1** but the content model carries an additive
`quarantine: Vec<QuarantineEvent>` seam (serde/ts-rs `default = []`) so quarantine can join later
with **no shape migration** (§ 3.1).

---

## 2. Decision record (grilled 2026-07-10, issue #91)

| # | Decision | Outcome |
|---|---|---|
| 1 | Granularity | **Per TASK**, aggregating every run it took (build → verify → fix rounds, retries). One receipt answering "can I trust THIS merge." The task IS the aggregation key — the ledger file, the transcript, and the persisted `structure_lock_result`/`review`/`fix_attempts` all already accumulate across a task's sessions (`store/ledger.rs:6-9`). |
| 2 | Surfaces | **All three:** (a) a **Trust band** in the TaskDetail drawer beside the Result band; (b) one-click **markdown export** (the shareable/demoable artifact); (c) **PR attachment** — receipt on the task's PR at create/finalize time, human-gated. |
| 3 | Contents | Gauntlet results (every gate pass/fail incl. structure-lock checks + reviewer verdict), guardrail events (policy holds, blocked/asked actions, diff-budget & anti-gaming triggers), flight-recorder summary (files touched, commands run, tokens/cost, session count). Quarantine EXCLUDED v1. |
| 4 | Nature | AGGREGATION/RENDERING over existing instrumentation. Computed-on-demand, NOT cached/persisted (§ 4.1). |
| 5 | "Tab" realization | The drawer has **no tab primitive** — it is band-based (`GroupLabel` sections, `TaskDetail.tsx:170-300`). The "Trust tab" ships as a **Trust band** placed immediately after the Result band (`TaskDetail.tsx:202`), literally beside `GauntletResults`/`ReviewPanel`. This is the faithful realization of "beside where verification lives." |
| 6 | Canonical structure | ONE structured `TrustReport` (Rust, ts-rs-exported) + ONE Rust markdown renderer. Drawer renders the struct natively; export + PR + in-drawer preview all render the one canonical markdown. No second renderer. |
| 7 | Gauntlet source of truth | Read `Task.structure_lock_result` + reviewer verdict **verbatim** (the merge-time truth). Do **NOT** re-run the readiness gauntlet (`run_gauntlet`) — it costs time, needs a worktree that may be gone post-merge, and reflects drift not the verified state (§ 3.3). |

---

## 3. Design — tier by tier

### 3.1 Contracts + type flow (Rust → TS via ts-rs, NOT zod)

The `TrustReport` shapes are **Rust-authored** (aggregated from Rust stores), so they follow the
`GauntletResult` codegen discipline, not the zod-first path: `#[derive(Serialize)]` +
`#[cfg_attr(test, derive(TS))]` + `#[cfg_attr(test, ts(export, export_to = "…"))]`, exactly like
`workflow/gauntlet/contract.rs:22-59`. `cargo test` regenerates `apps/web/src/lib/generated/*.ts`
(and the `bindings/` mirror); the types are **registered in `bindings/export.rs`** next to
`GauntletResult`/`StructureLockResult` (`bindings/export.rs:105-111`). Never hand-edit generated
files.

**Home:** new file `apps/desktop/src-tauri/src/workflow/trust/contract.rs` (sibling of
`workflow/gauntlet/contract.rs`). Content model (representative — final field set is the
implementer's, but the section split + additive seams are locked):

```
TrustReport {
  task_id, title, status, run_mode, branch, base_branch,
  pr_url, pr_number,
  generated_at,                         // mint time — a verifiable timestamp for the demo
  gauntlet:   GauntletTrust,
  guardrails: GuardrailTrust,
  flight:     FlightSummary,
  quarantine: Vec<QuarantineEvent>,     // v1: ALWAYS empty. #[serde(default)] + ts(optional-ish
                                        //     default []) — the additive seam; a future writer
                                        //     fills it with NO shape migration.
}

GauntletTrust {
  verified: bool,                       // Task.verified
  verdict: Option<String>,              // the extracted `VERDICT: …` line (parse_verdict idiom)
  review: Option<String>,               // Task.review (full reviewer text)
  fix_attempts: u32,                    // Task.fix_attempts (review-round count)
  structure_lock: Option<StructureLockResult>,  // REUSE the existing ts-rs type verbatim
}

GuardrailTrust {
  tools_evaluated, allowed, asked, denied: u32,   // counts over ledger decisions
  blocked: Vec<GuardrailEvent>,         // decision==deny  (tool, rule_id, digest, ts)
  asked_events: Vec<GuardrailEvent>,    // decision==ask
  policy_hold: Option<String>,          // blocked_by_policy_message(...) when protected-path denials exist
  scope_park: Option<String>,           // diff-budget/park message IFF the task currently carries it (§ 3.4)
}

FlightSummary {
  session_count: u32,                   // count of `session-start` markers in the ledger
  files_touched: Vec<String>,           // deduped Write/Edit/MultiEdit/NotebookEdit path digests (capped)
  files_touched_count: u32,
  commands: Vec<String>,                // Bash command digests (capped)
  commands_count: u32,
  cost_usd_last_run: Option<f64>,       // Task.cost_usd (authoritative, last run)
  cost_usd_total: Option<f64>,          // transcript-summed across sessions — the GAP (§ 6)
  tokens: Option<TokenTotals>,          // transcript-summed usage — the GAP (§ 6)
}

GuardrailEvent { tool, rule_id: Option<String>, digest: Option<String>, ts: Option<String>, decision }
QuarantineEvent { … }                   // v1 placeholder shape; fields TBD when quarantine lands
TokenTotals { input, output, reasoning_output, cache_read, cache_creation: u64 }
```

Reuse `StructureLockResult`/`StructureLockCheck`/`StepStatus` (`store/types.rs:29-96`,
already ts-rs-exported) verbatim inside `GauntletTrust` — do not re-model them.

### 3.2 Aggregation module — `workflow/trust/`

**Home:** new module `apps/desktop/src-tauri/src/workflow/trust/` (facade `mod.rs` + `contract.rs`
+ `aggregate.rs` + `render.rs` + `tests.rs`), a peer of `workflow/gauntlet/` and
`workflow/anti_gaming/`. Rationale per the backend-decomposition layer discipline: the aggregator
must compose **store readers** (`store::ledger`, `store::transcript`, the `TaskStore`) — so it
cannot live in `store/` (a persistence leaf). It is a read-only workflow flow; `commands/` stays a
thin wrapper over it.

`aggregate.rs::build_report(task: &Task, ledger_path: &Path, tasks_dir: &Path) -> TrustReport` is
**pure over the three inputs** (mirrors the diff-budget / anti-gaming "pure over parsed records"
posture, `workflow/diff_budget.rs:99-139`, `workflow/anti_gaming/ledger.rs:18-39`), so it is
unit-testable without git or a running engine:

1. **Gauntlet** ← `task.structure_lock_result`, `task.verified`, `task.review`,
   `task.fix_attempts`. Extract the `VERDICT:` line from `task.review` with the existing
   `parse_verdict` idiom (`sidecar/verification/verdict.rs:19-39`).
2. **Guardrails** ← `store::ledger::read_records(ledger_path)` (`store/ledger.rs:90-103`).
   Count by `decision`; collect `deny`/`ask` events; `policy_hold` via the existing classifiers
   `is_protected_path_denial()` / `blocked_by_policy_message()` (`store/ledger.rs:82-159`);
   `scope_park` per § 3.4.
3. **Flight summary** ← the same records: `session_count` = records where
   `event == Some("session-start")` (the reader already surfaces `event`, `store/ledger.rs:52-54`
   — **no struct change needed to count**); `files_touched` = deduped `input_digest` where
   `tool ∈ {Write, Edit, MultiEdit, NotebookEdit}`; `commands` = `input_digest` where
   `tool == "Bash"`. `cost_usd_last_run` = `task.cost_usd`. `cost_usd_total`/`tokens` = the new
   transcript summer (§ 3.5).

**Additive reader change (NOT a capture gap):** add `ts: Option<String>` to `LedgerRecord`
(`store/ledger.rs:46-68`). The engine ALREADY writes `ts` on every record
(`packages/engine/src/session/session-ledger.ts:63-69`); the Rust reader just doesn't parse it
yet. All `LedgerRecord` fields are already `Option + #[serde(default)]`, so this is a zero-risk
serde-additive parse that surfaces the per-event timestamps the demo wants. This is a reader
change, not new instrumentation.

### 3.3 Gauntlet section: read persisted, never re-run

`Task.structure_lock_result` is the ONLY per-task-persisted gauntlet artifact and it is the
merge-time truth (written at `sidecar/verification/handlers.rs:256-258`, absorbing anti-gaming
`sweep.rs:62-73`, contract-budget `contract_budget.rs:64-81`, ratchet `ratchet.rs:104-127`, and
the task verify-command). The Trust Report renders it **verbatim** together with the reviewer
verdict. It does NOT invoke `run_gauntlet` (`workflow/gauntlet/command.rs:15-20`) — the readiness
`GauntletResult` is intentionally ephemeral (web state + a transient merge/PR gate), reflects the
CURRENT working tree (drift), and needs a worktree that is often gone after merge. Re-running it
would make the receipt lie about what was verified. Locked.

### 3.4 Guardrail events: the durable vs. transient split (grounded)

| Event | Durability | Trust Report source |
|---|---|---|
| deny / ask / allow tiers | **Durable** — per-task ledger NDJSON, survives merge/cleanup (`.nightcore/ledger/` is gitignored + persistent) | ledger counts + `blocked`/`asked_events` lists |
| policy hold (blocked-by-policy) | **Durable** — derivable from ledger protected-path denials | `blocked_by_policy_message()` (`store/ledger.rs:110-159`) |
| anti-gaming trigger | **Durable** — persisted as an `anti-gaming` `StructureLockCheck` in `structure_lock_result` (incl. the `--no-verify` ledger evidence) | already rendered in the gauntlet section |
| **diff-budget trigger** | **Transient** — parks the task (`Task.status = WaitingApproval` + `Task.error`, `workflow/diff_budget.rs:53-74` + `handlers.rs:140-155`); a later run overwrites `Task.error`. NOT a persisted discrete event. | `scope_park` = the park message **only when the task currently carries it** (`status == WaitingApproval` and `error` matches a budget/policy park). Best-effort, labeled as such. |

So the report shows anti-gaming, deny/ask, and policy holds as durable history, and a diff-budget
breach only while the task is still parked for it. The transient diff-budget history is called out
in § 6 as a secondary (deferred) additive-capture, NOT the v1 open question.

### 3.5 Cost / tokens / session count

- **session_count**: durable — count `session-start` ledger markers (§ 3.2). No gap.
- **cost_usd_last_run**: `Task.cost_usd` (`store/task/model.rs:246`) — authoritative for the last
  run only.
- **cost_usd_total + tokens (aggregate across all sessions)**: the ONE capture gap (§ 6). The
  per-session `session-completed` events carry `costUsd` + `usage`
  (`packages/contracts/src/events.ts:226-243`) and are persisted verbatim to the task transcript
  (`sidecar/reader.rs:137-156`). Add a **full-file summing reader** to `store/transcript.rs`
  (a `pub(crate) fn cost_summary(tasks_dir, task_id) -> Option<CostSummary>`) that scans
  `transcript.jsonl` and sums `costUsd`/`usage` over `session-completed` records. This is pure
  aggregation over existing instrumentation — but see § 6 for the fix-session caveat.

### 3.6 The markdown renderer — one canonical structure (`workflow/trust/render.rs`)

`render.rs` turns a `TrustReport` into markdown. It is the single canonical renderer feeding
export + PR + in-drawer preview, sitting beside the house comment-builder `compose_push_comment`
(`workflow/pr_fix/comment.rs:31-75`) and `review_description` (`sidecar/pr_review.rs:332-351`).

Two thin entry points over one body builder:

- `render_markdown(&report) -> String` — local export (user's own machine).
- `render_for_github(&report) -> String` — wraps the same body with the house
  `### 🌙 Nightcore — Trust report` header + `---` + `_Posted from Nightcore._` footer
  (`compose_push_comment` idiom) and applies the GitHub-safe fencing below.

**Untrusted-content rendering (the design fork, resolved).** The ledger `files_touched` /
`commands` digests are repo/agent-derived and can carry adversarial text. The codebase's
`untrusted_block` (`infra/untrusted.rs:20-28`) is a **prompt** fence (emits an `<analysis-finding>`
block that renders as noise in a GitHub markdown body) and is used ONLY when framing untrusted
text *into an agent* — never in the GitHub-post path, which today posts only trusted Nightcore text
+ inline-code-fenced paths (`compose_push_comment`, `prreview-compose.ts:1-5,31`). Follow that
house convention: render every untrusted span (paths, command lines) as an **inline code span**
(`` `…` ``) after (a) mapping control chars to spaces and collapsing whitespace (the
`sanitize_minted_title` idiom, `store/task/model.rs:450-465`) and (b) neutralizing embedded
backticks/fence-breakers (the `defuse_fence` idea, `infra/untrusted.rs:36-67`) so a crafted digest
cannot break out of its code span. `untrusted_block` proper is reserved for the (out-of-scope)
case where a receipt is ever fed back INTO an agent prompt.

**What makes it demoable to a skeptic** (competitive-landscape opportunity #2 framing — name these
in the rendered output so the artifact is self-evidently grounded, without inventing scope):
- **Timestamps** — `generated_at` on the report + per-event `ts` on blocked/asked lines + the
  session markers give a checkable chronology.
- **Gate identities** — each `StructureLockCheck` prints its `kind`/`name` and the exact
  `command` line that ran; the reviewer verdict prints the literal `VERDICT:` line.
- **Verifiable counts** — "N tool calls evaluated (allowed A · asked K · denied D)", "S sessions",
  "F files touched", "C commands", cost — every number traces to a persisted record.
- **Provenance** — task id, branch/base, PR URL/number.

### 3.7 Commands (`commands/trust.rs`, thin over `workflow::trust`)

Register in `lib.rs`'s `generate_handler!` beside `gauntlet::run_gauntlet` /
`commands::transcript::read_transcript` (`lib.rs:267,296`):

- `trust_report(task_id) -> TrustReport` — resolve the project root + ledger path
  (`resolve_ledger_path` idiom, `sidecar/commands.rs:135-138`), load the task, call
  `aggregate::build_report`. Async + `spawn_blocking` for the file reads (the sync-command
  WKWebView-freeze trap, `reference_tauri_command_threading`).
- `trust_report_markdown(task_id, for_github: bool) -> String` — `build_report` → `render_*`.
- `write_trust_report(task_id, dest_path) -> ()` (PR 2) — `build_report` → `render_markdown` →
  atomic write to `dest_path` via `store::atomic::write_atomic` (mirrors the backend-writes-the-
  artifact idiom of `apply_harness_artifact`; `dest_path` is a user-chosen path from the web
  save-dialog — validate it is absolute and not inside `.nightcore/`).
- `attach_trust_report_to_pr(task_id) -> ()` (PR 3) — see § 3.9.

### 3.8 Web surface — the Trust band (`apps/web/src/components/board/TrustReport/`)

Folder-per-component, cloning the 6-file `GauntletResults/` template
(`GauntletResults.tsx`/`.hooks.ts`/`.types.ts`/`.stories.tsx`/`.test.tsx`/`index.ts`). Renders the
structured `TrustReport` natively (pass/fail pills + counts, reusing the `GauntletResults` +
`ReviewPanel` visual idiom) with:

- a compact summary (verdict pill, gauntlet PASSED/FAILED, "D denied · K asked", "S sessions ·
  cost"),
- **Export** (save the markdown artifact),
- **Preview** (render the canonical markdown via the existing `<Markdown>` component,
  `components/ui/Markdown`),
- **Attach to PR** (PR 3; shown only when `task.prUrl` is set), behind a `ConfirmDialog`.

**Plumbing** (mirror `gauntlet`): bridge command wrappers in new
`apps/web/src/lib/bridge/commands/trust.ts`; the drawer object in `AppShell.hooks.ts:242-251`
gains a `trust` slice; passed through `AppShellViews.tsx:149-166` as a prop to `TaskDetail`.
Insertion: a new `<div className="space-y-3"><GroupLabel>Trust</GroupLabel>…</div>` band
immediately after the Result band at `TaskDetail.tsx:202`. New ts-rs types land in
`lib/generated/` (none exist for trust today).

**Export mechanics:** the web `save()` from `@tauri-apps/plugin-dialog` (already a dependency,
open-dialog used at `lib/bridge/commands/projects.ts:96-100`; `save` is the same plugin) picks a
`*.md` path, then `invoke('write_trust_report', { taskId, destPath })` renders + writes Rust-side.
This keeps the canonical renderer Rust-side (one renderer) while the path choice is a native
dialog. No new dependency, no browser-download idiom introduced.

### 3.9 PR attachment (human-gated)

Two seams, both human-gated on the web side (the Rust commands never self-gate —
`pr_review_post/post.rs:133-134`):

- **Create-time (into the PR body):** the PR body is composed web-side and handed to
  `create_pr_task` as a passthrough string (`workflow/pr/create.rs:66-82,353-378`, `--body-file -`
  on stdin). Add an **"Include governance receipt" checkbox (default on)** to `CreatePRDialog`;
  when checked, append `trust_report_markdown(taskId, for_github=true)` to the composed body before
  submit. The dialog IS the existing human gate (`useCreatePr.hooks.ts:27-76`). No Rust change to
  the create path. (Fallback, documented not chosen: wrap the body Rust-side in
  `create_pr_task_blocking` before `create_or_recover_with`, `pr/create.rs:161-169`.)
- **After create / at finalize (as a PR comment):** `attach_trust_report_to_pr(task_id)` renders
  `for_github` markdown and posts it as a conversation comment via the existing atomic idiom —
  `gh api --method POST repos/{owner}/{repo}/issues/{n}/comments --input -` with a
  `json!({ "body": body })` stdin payload (clone `post_push_comment_with`,
  `workflow/pr_fix/comment.rs:87-107`; bound by a `GH_COMMENT_TIMEOUT`-style deadline,
  `comment.rs:22`). Triggered from the Trust band's "Attach to PR" action behind a `ConfirmDialog`
  (the review-post gate idiom, `PrReviewView.tsx:133-140`). `{owner}/{repo}` resolve from the cwd
  repo via `gh`, never a raw URL over IPC.

**Lease constraint:** if a receipt is ever posted *inside* the create path it runs under the
already-held `pr_in_flight` lease (`pr/create.rs:32-35`) and must NOT re-acquire it. The standalone
`attach_trust_report_to_pr` comment post is a separate action — follow the `comment.rs` posture
(own timeout, no create/merge lease), and it is naturally single-flight per task via the web
action-pending guard.

---

## 4. Constraints carried (do not violate)

1. **Zero new instrumentation.** Aggregation only. The sole additive touches are readers:
   `LedgerRecord.ts` parse (§ 3.2), `session-start` counting (no struct change), and the
   transcript cost summer (§ 3.5). No new writer, no new event.
2. **`.nightcore/` layouts untouched.** No new directory, no new persisted record, no schema
   change to `tasks/`, `ledger/`, or `transcript.jsonl`. The `TrustReport` is computed and
   returned, never stored (§ 4.1).
3. **Computed-not-persisted** (locked decision 4). Re-derive on every request; correctness over a
   cache.
4. **Quarantine additive seam.** `quarantine: Vec<QuarantineEvent>` defaults `[]` (serde + ts-rs
   additive) so it joins later with no migration (§ 3.1).
5. **PR attachment is human-gated** like the rest of the PR system (web `ConfirmDialog` / dialog
   checkbox; Rust never self-gates).
6. **Untrusted content** (ledger paths/commands) rendered via the house inline-code-fence +
   control-char-sanitize + fence-defuse convention when posted to GitHub (§ 3.6), NOT via the
   prompt-only `untrusted_block`.
7. **Terminal scrollback stays out.** The terminal seam is USER-ONLY and its scrollback may hold
   secrets — the Trust Report never reads `.nightcore/terminals/`
   (`docs/research/2026-07-10-terminal-build-spec.md:37-39`).

### 4.1 Computed vs. cached (decided)

**Computed on demand.** The inputs are small (one task JSON, one ledger NDJSON ≤ 5 MB hard-capped
by the engine writer, one transcript). Reads are cheap and the aggregation is pure. Caching would
add a persistence surface (violating constraint 2) and risk a stale receipt after a fix round. The
rejected alternative — persisting a `TrustReport` on the task — is documented only for
completeness; it buys nothing here and costs a schema change.

---

## 5. Codegen / lint lockstep checklist

| Concern | File | PR | Action |
|---|---|---|---|
| ts-rs export registration | `apps/desktop/src-tauri/src/bindings/export.rs:105-111` | 1 | Register `TrustReport` + nested structs beside `GauntletResult`/`StructureLockResult`. `cargo test` regenerates `apps/web/src/lib/generated/*` + `bindings/*`. Never hand-edit. |
| Command registration | `apps/desktop/src-tauri/src/lib.rs:267,296` | 1/2/3 | Add each `commands::trust::*` to `generate_handler!`. |
| Reuse existing generated types | `store/types.rs` (`StructureLockResult` etc.) | 1 | Reuse verbatim inside `GauntletTrust` — do not re-model. |
| Web folder-per-component | `packages/eslint-plugin/` rules | 2 | `TrustReport/` must satisfy `component-folder-structure` / thin-shell / hook-budget; it lives under `board/` (no cross-feature import concern). Validate with `bun run lint`. |
| lint-meta | `tools/lint-meta/` | 1-3 | No new lint-meta rule needed; `TrustReport` is not a `source-ref.ts` REGISTRY view (no nav-render-parity concern) and not a scan family (no scan-family-parity concern). Validate with `bun run lint:meta` (zero violations on a clean tree). |
| No new `nightcore/*` ESLint rule | `tools/lint-meta/rules/agent-contract-parity.ts` | — | Unaffected — avoid the AGENTS.md-parity trap by not wiring a new ESLint rule. |

---

## 6. THE single open question — the one named capture gap

**Gap: aggregate cost + token totals across ALL of a task's runs.**

- **What exists:** `Task.cost_usd` holds only the LAST run's cost (overwritten every run,
  `store/task/model.rs:246`). Per-session cost + token `usage` ARE captured — on the
  `session-completed` events (`packages/contracts/src/events.ts:226-243`) persisted verbatim to
  `transcript.jsonl` (`sidecar/reader.rs:137-156`). So an aggregate IS derivable by summing the
  transcript (§ 3.5) — **pure aggregation, no new instrumentation.**
- **The wrinkle:** PR-**fix** sessions are deliberately **skipped from the transcript**
  (`sidecar/reader.rs:133-137` — a `prfix-*`-keyed stream is never persisted), so a
  transcript-summed total slightly **under-counts** the spend of any fix round.
- **v1 recommendation (chosen):** ship `cost_usd_total`/`tokens` as the transcript-summed
  aggregate, **labeled** in the render — "≈ $X total across S sessions (excludes fix-session
  spend)". `session_count`, `cost_usd_last_run`, and everything else are exact.
- **Smallest additive capture (the actual open question to confirm before/at build):** if an exact
  total is required, the minimal fix is to persist each session's terminal cost — either (a) stop
  skipping ONLY the terminal `session-completed` event of a fix session for transcript purposes, or
  (b) append a one-line `{cost, usage, sessionId}` record to the ledger on session-end (the ledger
  already has session markers). Both are tiny additive writes; both are OUT of v1 unless the
  reviewer insists on exact fix-round cost.

**Secondary, deferred (NOT the open question, just noted):** diff-budget breaches are transient
(§ 3.4) — only visible while the task is parked. A durable capture (a structured park-event) is a
future additive change; v1 shows the breach best-effort from `Task.error`.

Everything else in the locked content set is already captured and needs no instrumentation:
gauntlet + reviewer verdict (persisted on the task), deny/ask/allow guardrail events + policy holds
+ anti-gaming (ledger + `structure_lock_result`), files touched + commands run + session count
(ledger).

---

## 7. PR slicing (implement one at a time; each independently green)

Staged like the PR-system waves: PR 1 lands the Rust aggregation + types + commands (fully
testable headless); PR 2 adds the drawer band + export; PR 3 wires PR attachment. PR 2 depends on
PR 1; PR 3 depends on PR 1 (renderer) + PR 2 (the band hosts the attach action).

### PR 1 — Rust aggregation + contracts + commands

- **Scope:** new `workflow/trust/` (`mod.rs`, `contract.rs`, `aggregate.rs`, `render.rs`,
  `tests.rs`); the additive `ts` parse on `LedgerRecord`; the transcript `cost_summary` reader;
  `commands/trust.rs` with `trust_report` + `trust_report_markdown`; ts-rs registration in
  `bindings/export.rs`; `generate_handler!` wiring in `lib.rs`.
- **Encodes:** computed-on-demand aggregation over task + ledger + transcript; the canonical
  content model incl. the `quarantine` additive seam; the one canonical markdown renderer with
  GitHub-safe fencing; read-persisted-never-re-run gauntlet.
- **Green because:** additive module + additive commands; `cargo test` regenerates + commits the
  ts-rs output (new, unused TS files are valid — web typecheck unaffected); no existing behavior
  touched. `bun run lint`/`lint:meta`/web typecheck are no-ops for this PR.

### PR 2 — Drawer Trust band + markdown export

- **Scope:** `apps/web/src/components/board/TrustReport/` (6-file folder); bridge wrappers in
  `lib/bridge/commands/trust.ts`; `trust` slice in `AppShell.hooks.ts` threaded through
  `AppShellViews.tsx` to `TaskDetail`; the Trust band after the Result band
  (`TaskDetail.tsx:202`); the `write_trust_report` command + the web `save()` export flow +
  `<Markdown>` preview.
- **Encodes:** surfaces (a) drawer band and (b) one-click markdown export; native render of the
  structured report + canonical-markdown preview.
- **Green because:** additive UI (folder-per-component satisfies the ESLint plugin) + one additive
  Rust command (ts-rs-neutral — returns `()`); `bun run lint`, web typecheck/test, cargo test all
  pass.

### PR 3 — PR attachment (create checkbox + finalize/attach comment)

- **Scope:** the "Include governance receipt" checkbox in `CreatePRDialog` (appends
  `for_github` markdown to the body pre-submit); `attach_trust_report_to_pr` command (clone
  `post_push_comment_with`, `gh api …/issues/{n}/comments`); the Trust band "Attach to PR" action
  behind a `ConfirmDialog`, shown only when `task.prUrl` is set.
- **Encodes:** surface (c) — governance visible on GitHub, human-gated, GitHub-safe fencing.
- **Green because:** additive command + additive web action/dialog; reuses the existing create
  body passthrough (no create-path Rust change) and the existing comment-post + gate idioms.

---

## 8. Test plan (clone the named idioms; every file already exists)

1. **Aggregator — pure over synthetic inputs** (`workflow/trust/tests.rs`, PR 1). Clone the ledger
   test harness `write_ledger(&[…])` (`store/ledger.rs:165-170`) + a synthetic `Task` with a
   populated `structure_lock_result`/`review`/`fix_attempts`/`cost_usd`. Assert: decision counts;
   `blocked`/`asked` lists; `policy_hold` fires on protected-path denials and is `None` otherwise
   (mirror `park_message_is_none_without_protected_path_denials`, `store/ledger.rs:248-260`);
   `session_count` counts `session-start` markers; `files_touched` dedupes; `commands` collects
   Bash digests; gauntlet section mirrors the task verbatim.
2. **Transcript cost summer** (`store/transcript.rs` tests, PR 1). Clone `temp_store()` +
   `append_event` (`store/transcript.rs:401-417`); append two `session-completed` events with
   `costUsd`/`usage` and assert the summed total + tokens; assert a task with no transcript yields
   `None` (the missing-transcript-is-empty posture, `:473-477`).
3. **Renderer golden-ish** (`workflow/trust/tests.rs`, PR 1). Assert the markdown contains the
   `VERDICT:` line, each gate `command`, the counts, and the timestamps; assert an untrusted
   digest with a backtick / control char / newline is neutralized into a single safe code span
   (clone the `sanitize_minted_title` assertions, `store/task/model.rs:480-511`); assert
   `render_for_github` carries the `_Posted from Nightcore._` footer (clone the
   `compose_push_comment` tests).
4. **Serde/ts-rs additive** (`workflow/trust/contract.rs` tests, PR 1). Assert the `quarantine`
   seam defaults `[]` and a report without it round-trips (clone the serde-additive round-trip
   idiom, `store/task/model.rs:951-987`).
5. **Trust band render + states** (`TrustReport.test.tsx` + `.stories.tsx`, PR 2). Stories for
   verified-pass / gauntlet-failed / denials-present / empty (no runs yet); test the export action
   invokes `write_trust_report`, the preview renders markdown, and "Attach to PR" is hidden without
   a `prUrl`. Clone the `GauntletResults.test.tsx`/`.stories.tsx` per-status convention.
6. **Drawer integration** (`TaskDetail.test.tsx`, PR 2). Extend a story to show the Trust band
   renders beside the Result band for a verified task (clone the `FromScanProvenance` story
   pattern, `TaskDetail.stories.tsx`).
7. **PR attach post** (`workflow/trust/tests.rs` or beside `pr_fix` tests, PR 3). Assert the
   comment payload is built with `json!` (never string-formatting) and the endpoint is
   `repos/{owner}/{repo}/issues/{n}/comments` (clone `post_push_comment_with` tests,
   `workflow/pr_fix/tests.rs`); assert the create-dialog checkbox appends the receipt to the body
   (web hook test, clone `useCreatePr.hooks.test.tsx`).

---

## 9. Verification gates (run per PR)

```
bun run lint                              # eslint-plugin (folder-per-component on TrustReport/) + scan-family-parity
bun run lint:meta                         # lint-meta; zero violations on a clean tree
bun run --filter @nightcore/web typecheck # root `tsc -b` does NOT cover apps/web
bun run --filter @nightcore/web test      # PR 2/3 web tests
cargo fmt --all --check                   # MUST run from apps/desktop/src-tauri — root has no Cargo.toml and silently no-ops
cargo clippy --all-targets                # from apps/desktop/src-tauri
cargo test                                # regenerates ts-rs (PR 1 adds TrustReport bindings — commit them) + aggregator/renderer/command tests
bun run dogfood:ui                        # manual: Trust band renders, export writes a .md, preview shows the receipt, attach gates through ConfirmDialog
```

- **PR 1** is the only PR where `cargo test` performs a real ts-rs regen (the new `TrustReport`
  bindings) — commit both `apps/web/src/lib/generated/*` and `bindings/*`; never hand-edit them.
- **PR 3**'s `dogfood:ui` must show the create-dialog checkbox appending the receipt and the
  "Attach to PR" action posting only after the `ConfirmDialog` confirm.
