# Issue Triage — build spec (2026-07-04)

GitHub issue intake for Nightcore: fetch a project's open issues, validate a selected
issue against the actual codebase with a selected model, return a verdict (valid bug /
feature request / invalid / needs clarification) with grounded findings, complexity and
a proposed implementation plan — then let the user post the verdict as a GitHub comment
on the issue, convert it into a board task, or both.

Ported from Automaker's `github-issues-view` + `validate-issue` route
(`/Users/shirone/Documents/Projects/automaker/libs/types/src/issue-validation.ts` is the
reference data model), rebuilt Nightcore-style on the existing scan/session machinery.

## Why this feature

The flow the user relied on daily in Automaker: issue → validate → task → PR → review.
Nightcore already has the tail of that pipeline (tasks, worktrees, PR create/finalize/
address-comments, AI PR review). This adds the head. It is also deliberately the dogfood
payload for the PR system: this task runs in a worktree, its branch becomes a real PR on
`Shironex/nightcore`, and the AI PR reviewer reviews it.

## UX flow

1. **Issues view** (new sidebar entry): list the project's open GitHub issues — number,
   title, labels, author, age, comment count, linked-PR badges. Client-side filter by
   label/text. Empty/error/loading states per house style.
2. User selects an issue → detail panel shows body + comments (rendered markdown,
   clearly framed as untrusted content).
3. **Validate** button → model picker (+ effort), mirroring how scans pick models. One
   read-only validation session per issue.
4. **Results panel** on completion: verdict card (kind + verdict + confidence),
   reasoning, `bugConfirmed`, grounded `relatedFiles` (must exist in repo — reuse the
   Insight grounding pass), `estimatedComplexity`, step-by-step `proposedPlan`,
   `missingInfo` (when needs-clarification), and `prAnalysis` when the issue has linked
   PRs (does the open PR already fix it → wait_for_merge / pr_needs_work / no_pr).
5. **Actions** (each human-gated, each independently usable):
   - **Post as comment** — preview dialog showing the exact markdown, then one atomic
     `gh api repos/{owner}/{repo}/issues/{n}/comments` post. Never auto-posts.
   - **Convert to task** — creates a board task whose description embeds the verdict in
     an `<analysis-finding>`-style untrusted block (mirror Insight convert), with
     `sourceRef` linking back to the validation, suggested `kind` (bug→build/tdd,
     feature→build, complex feature→decompose) and complexity→effort mapping.
   - Both.
6. Validations persist per project with `validatedAt`, `model`, `viewedAt` — reopening
   the view shows cached verdicts; re-validate is an explicit action (badge staleness
   when the issue's `updatedAt` is newer than `validatedAt`).

## Data model (contracts tier)

New `packages/contracts/src/issue-triage.ts` (follow the `zod-schema-naming` rule; it
is ENFORCED on contracts — Event/Command/Query carve-out applies):

- `IssueSummary` — number, title, state, labels, author, createdAt/updatedAt,
  commentCount, linkedPRs `{number, title, state}[]`.
- `IssueComment` — id, author login, body, createdAt.
- Verdict result (adapted from Automaker, split "what is it" from "is it real"):
  - `issueKind`: `bug_report | feature_request | question | unknown`
  - `verdict`: `valid | invalid | needs_clarification`
  - `confidence`: `high | medium | low`
  - `reasoning`: string
  - `bugConfirmed?`: boolean (bug reports only)
  - `relatedFiles?`: repo-relative paths (grounded)
  - `estimatedComplexity?`: `trivial | simple | moderate | complex | very_complex`
  - `proposedPlan?`: string (step-by-step, markdown)
  - `missingInfo?`: string[]
  - `prAnalysis?`: `{ hasOpenPR, prNumber?, prFixesIssue?, prSummary?, recommendation: wait_for_merge | pr_needs_work | no_pr }`
- Stored validation: issueNumber, issueTitle, validatedAt, model, result, viewedAt?.
- Commands/events for: list issues, fetch comments, start/cancel validation, validation
  progress/complete/error events, post comment, convert to task.

## Engine tier (`packages/engine/src/scans/issue-triage/` or `session/` sibling)

- One **read-only** session per validation: reuse `ANALYSIS_ALLOWED_TOOLS` /
  `ANALYSIS_DISALLOWED_TOOLS` from `scans/shared/presets.ts` (Read/Glob/Grep/LS only —
  NO Bash, NO network; all GitHub data is pre-fetched and injected into the prompt).
- Prompt: analyzer persona + issue title/body/comments/linked-PR summaries wrapped in
  the existing `untrusted_block` helper (issue bodies are attacker-controlled — same
  injection posture as PR review). Instructions: investigate the codebase before any
  claim; classify kind; verdict; confidence; ground every file ref; propose a plan; if
  a linked open PR diff is provided, judge whether it fixes the issue.
- Output: strict JSON contract (single object, not array) parsed with the shared
  parse→ground→validate helpers in `scans/shared/findings.ts` (ground `relatedFiles`
  against the repo; drop paths that don't exist rather than failing the run).
- Linked-PR diffs: pre-fetched by the Rust/gh seam (`gh pr diff` capped at N KB),
  injected as untrusted context — the session itself never shells out.

## Rust tier

- `store/issue_triage.rs` using the generic `RunStore<R>` pattern (persist under
  `.nightcore/issue-validations/`).
- gh operations go through the existing deduped gh seam (from the PR system):
  - list open issues + linked PRs: `gh api graphql` — remember `-f query=` and
    errors[]-first parsing.
  - fetch comments (REST or graphql, paginated; cap initial fetch, no infinite scroll
    requirement).
  - post comment: single atomic `gh api .../comments -f body=@-` (body via stdin, never
    interpolated into argv).
- Commands in `commands/` (async, `spawn_blocking` where they shell out — a sync
  `#[tauri::command]` blocks WKWebView). Serde-additive fields only.
- Codegen both ways after contract changes: zod→Rust `generated.rs` codegen script AND
  `cargo test` to regenerate ts-rs types in `apps/web/src/lib/generated/`.

## Web tier (`apps/web/src/components/issues/`)

- Folder-per-component per the eslint plugin (run `bun run lint` before done — it
  enforces folder structure, no-state-in-body, no-cross-feature-imports).
- New `AppView` value + Sidebar entry. TRAP from the PR system: keep the sourceRef key
  and the AppView spelling consistent and documented (pr-review vs prreview bit us).
- Reuse existing ui/ primitives (RunProgress, CodeBlock, untrusted-content framing,
  model picker) — do not invent new siblings of things that exist.

## Security / hardening checklist

- All GitHub-sourced text (titles, bodies, comments, PR summaries) enters prompts only
  inside `untrusted_block`; rendered in UI with the existing untrusted framing.
- Validation sessions are read-only tool sets; no Bash/Web tools; no MCP.
- Posting to GitHub is ALWAYS behind an explicit user-confirmed preview dialog.
- Comment body built from the structured result (not raw model prose) with a
  "Validated by Nightcore (<model>, <date>)" footer.
- Convert-to-task embeds analysis output inside the standard warning-framed
  `<analysis-finding>` block, matching Insight convert.

## Non-goals (this task)

- No batch "validate all" (single-issue validation only; the list may multi-select but
  validation runs one at a time).
- No issue creation/closing/labeling from Nightcore.
- No auto-posting of comments, ever.
- No providers other than GitHub via `gh`.
- No comment-thread pagination beyond the first page cap.

## Acceptance

- All four gates green: rust / node / web / plugin tests + `bun run lint` +
  `bun run lint:meta`.
- Manual: on the Nightcore repo itself, list real issues, validate one with a chosen
  model, see a grounded verdict, post a comment to a scratch issue, convert to a task
  that lands in Backlog with a well-formed description and sourceRef.
- Unit tests: contract schemas, engine JSON parse/ground path (fixture transcripts),
  Rust store round-trip, comment-body builder.
