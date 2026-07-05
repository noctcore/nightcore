import { z } from 'zod';

/**
 * `@nightcore/contracts` — Issue Triage (GitHub issue intake + validation) shapes.
 *
 * The head of the issue → validate → task → PR → review pipeline. A project's open
 * GitHub issues are listed (via the deduped `gh` seam, Rust-side), one is validated
 * against the actual codebase by a single READ-ONLY Claude session, and the session
 * emits ONE structured verdict object (kind + verdict + confidence + grounded
 * findings + a proposed plan) — the model of Insight/PR-Review, but one object per
 * issue instead of a batch of severity-ranked findings. The verdict can then be
 * posted back as a GitHub comment or converted to a board task.
 *
 * Zod-only: like `insight.ts` / `pr-review.ts`, this module imports nothing from
 * `commands.ts` / `events.ts`, so those can import {@link IssueCommentSchema} /
 * {@link IssueLinkedPrContextSchema} / {@link IssueValidationResultSchema} without a
 * cycle.
 *
 * SECURITY: every GitHub-sourced text field here — issue title/body, comment body,
 * linked-PR title/diff, and any model prose derived from them (`prSummary`,
 * `reasoning`, `proposedPlan`) — is ATTACKER-CONTROLLED. These are modelled as plain
 * strings with NO "trusted" marker: downstream tiers wrap them in the existing
 * `untrusted_block` prompt framing (engine) and the untrusted-content UI framing
 * (web). Do not add a field that implies any of this text is safe to trust.
 *
 * Two properties the consumer slices MUST preserve (asserted here so they aren't
 * lost between slices):
 *   1. The `untrusted_block` wrapper must be DELIMITER-SAFE — attacker content that
 *      embeds the block's own open/close marker must not be able to break out of the
 *      wrapper (a classic wrapper-escape). The engine slice owns a test for this.
 *   2. The GitHub logins (`issueAuthor`, `IssueComment.author`) are DISPLAY-ONLY.
 *      An attacker chooses their own login, so these must NEVER feed a trust or
 *      privilege decision (e.g. treating `author === 'maintainer'` as authoritative).
 *
 * SIZE: the attacker-controlled string/array fields carry explicit `.max(...)` bounds
 * (see the `ISSUE_*_MAX*` caps below) so the contract — the enforced trust boundary
 * the sidecar and model sit behind — rejects a pathological multi-megabyte payload at
 * parse time rather than relying solely on the (prose-asserted) Rust-side cap. The
 * Rust core keeps its own cap too (defense-in-depth).
 *
 * NAMING: the eslint `zod-schema-naming` rule (error on contracts) requires every
 * exported schema be PascalCase ending `Schema`, paired with `export type X`. The
 * discriminated-union MEMBERS that back the engine protocol live in `commands.ts` /
 * `events.ts` and carry the `Command` / `Event` role suffix instead; this module has
 * only data shapes, so every export ends `Schema`. The `PR` acronym is spelled
 * `Pr`/`pr` everywhere (camelCase-consistent: `linkedPrs`, `hasOpenPr`, `prNumber`)
 * so no field needs a bespoke serde rename in the generated Rust mirror.
 */

/**
 * Defense-in-depth size caps on the ATTACKER-CONTROLLED GitHub text this module
 * carries inline into a validation session. Sized to GitHub's own field limits plus
 * headroom, so they never reject a legitimate issue — only a pathological payload
 * crafted to inflate memory / token cost / context-window pressure. The Rust `gh`
 * seam caps before injecting too; these bounds make the cap structural (a regression
 * fails a schema test) instead of prose-only.
 */
export const ISSUE_TITLE_MAX_LEN = 1_024;
export const ISSUE_BODY_MAX_LEN = 65_536;
export const ISSUE_COMMENT_BODY_MAX_LEN = 65_536;
/** A linked PR's capped `gh pr diff` output. Larger than a body (a diff spans many
 *  files) but still bounded so a crafted giant diff can't flood the session. */
export const ISSUE_PR_DIFF_MAX_LEN = 1_048_576;
export const ISSUE_LABELS_MAX = 100;
export const ISSUE_COMMENTS_MAX = 100;
export const ISSUE_LINKED_PRS_MAX = 50;

/** Lifecycle state of a GitHub issue. */
export const IssueStateSchema = z.enum(['open', 'closed']);
export type IssueState = z.infer<typeof IssueStateSchema>;

/** Lifecycle state of a linked GitHub pull request (a PR can be merged, an issue
 *  cannot — so this is a distinct value-set from {@link IssueStateSchema}). */
export const IssuePrStateSchema = z.enum(['open', 'closed', 'merged']);
export type IssuePrState = z.infer<typeof IssuePrStateSchema>;

/** What the issue actually IS, judged by the validation session — split from
 *  {@link IssueVerdictSchema} ("is it real / actionable") so a valid bug and a valid
 *  feature request share one verdict axis but keep distinct kinds. `unknown` is the
 *  honest fallback when the model can't classify. */
export const IssueKindSchema = z.enum([
  'bug_report',
  'feature_request',
  'question',
  'unknown',
]);
export type IssueKind = z.infer<typeof IssueKindSchema>;

/** Whether the issue is actionable as written. `needs_clarification` pairs with a
 *  populated `missingInfo` list on the result. */
export const IssueVerdictSchema = z.enum([
  'valid',
  'invalid',
  'needs_clarification',
]);
export type IssueVerdict = z.infer<typeof IssueVerdictSchema>;

/** The model's self-rated confidence in its verdict. */
export const IssueConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type IssueConfidence = z.infer<typeof IssueConfidenceSchema>;

/** Estimated implementation effort, mapped by the convert-to-task path to a board
 *  effort. Ordered trivial→very_complex. */
export const IssueComplexitySchema = z.enum([
  'trivial',
  'simple',
  'moderate',
  'complex',
  'very_complex',
]);
export type IssueComplexity = z.infer<typeof IssueComplexitySchema>;

/** The recommendation when the issue has a linked open PR: keep waiting for the
 *  existing PR to merge, the PR needs more work, or there is no PR that fixes it. */
export const IssuePrRecommendationSchema = z.enum([
  'wait_for_merge',
  'pr_needs_work',
  'no_pr',
]);
export type IssuePrRecommendation = z.infer<typeof IssuePrRecommendationSchema>;

/** A pull request linked to an issue, as a list-view badge. `title` is
 *  GitHub-sourced (untrusted). No diff here — the diff is a separate, capped
 *  fetch carried only into the engine on {@link IssueLinkedPrContextSchema}. */
export const IssueLinkedPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(ISSUE_TITLE_MAX_LEN),
  state: IssuePrStateSchema,
});
export type IssueLinkedPr = z.infer<typeof IssueLinkedPrSchema>;

/** One issue as it appears in the list view. Deliberately omits the issue BODY (a
 *  list summary): the body is fetched with the detail view and injected into the
 *  validation prompt separately. `title` and every label are GitHub-sourced
 *  (untrusted). Timestamps are ISO-8601 strings (GitHub's wire format). This shape
 *  is returned by the Rust `gh` seam and consumed by the web list; it is NOT part of
 *  the engine NDJSON protocol, so it is not mirrored into `generated.rs`. */
export const IssueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(ISSUE_TITLE_MAX_LEN),
  state: IssueStateSchema,
  labels: z.array(z.string()).max(ISSUE_LABELS_MAX).default([]),
  /** The issue author's GitHub login. Display-only (an attacker chooses their own
   *  login) — never a trust/privilege input. */
  author: z.string(),
  /** ISO-8601 creation time (GitHub `created_at`). */
  createdAt: z.string(),
  /** ISO-8601 last-update time (GitHub `updated_at`); drives staleness badging when
   *  it is newer than a stored validation's `validatedAt`. */
  updatedAt: z.string(),
  commentCount: z.number().int().nonnegative(),
  /** PRs linked to this issue (list-view badges). Named `linkedPrs` to match the
   *  engine command's `StartIssueValidationCommand.linkedPrs` — one concept, one
   *  camelCase spelling across both representations. */
  linkedPrs: z.array(IssueLinkedPrSchema).max(ISSUE_LINKED_PRS_MAX).default([]),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

/** One comment on an issue. `body` is GitHub-sourced (untrusted). Carried (capped to
 *  the first page — see the "no pagination" non-goal) into the validation prompt as
 *  untrusted context. */
export const IssueCommentSchema = z.object({
  /** GitHub comment id (string; GitHub node/REST ids exceed a safe JS integer). */
  id: z.string(),
  /** The comment author's GitHub login. Display-only (an attacker chooses their own
   *  login) — never a trust/privilege input. */
  author: z.string(),
  /** The comment markdown (untrusted); capped so a giant comment can't flood the
   *  session context. */
  body: z.string().max(ISSUE_COMMENT_BODY_MAX_LEN),
  /** ISO-8601 creation time. */
  createdAt: z.string(),
});
export type IssueComment = z.infer<typeof IssueCommentSchema>;

/** A linked PR plus its (capped) diff, as injected into the validation session. The
 *  Rust `gh` seam pre-fetches `gh pr diff <n>` and caps it — the read-only session
 *  never shells out. `title` and `diff` are attacker-controlled (untrusted). This
 *  shape IS part of the engine command, so it is mirrored into `generated.rs`. */
export const IssueLinkedPrContextSchema = IssueLinkedPrSchema.extend({
  /** The capped `gh pr diff <n>` output (untrusted); absent when no diff was
   *  fetchable. Bounded so a crafted giant diff can't flood the session context. */
  diff: z.string().max(ISSUE_PR_DIFF_MAX_LEN).optional(),
});
export type IssueLinkedPrContext = z.infer<typeof IssueLinkedPrContextSchema>;

/** The validation's analysis of a linked open PR: does the existing PR already fix
 *  the issue, and what should happen next. Present on the result only when the issue
 *  had a linked PR to reason about. `prSummary` is model prose derived from an
 *  untrusted diff (untrusted). */
export const IssuePrAnalysisSchema = z.object({
  /** True when the issue has an OPEN linked PR the analysis considered. This boolean
   *  is AUTHORITATIVE; `recommendation: 'no_pr'` is a UI hint that may lag it (this
   *  is LLM output, so a loose/fail-open shape is intentional — the model may not
   *  localize a `prNumber` even when a PR exists). Consumers key off `hasOpenPr`, not
   *  the redundant `no_pr` enum value. */
  hasOpenPr: z.boolean(),
  /** The PR the analysis focused on, when localizable. */
  prNumber: z.number().int().positive().optional(),
  /** The model's judgement of whether that PR fixes the issue. */
  prFixesIssue: z.boolean().optional(),
  /** One-paragraph summary of the PR's relevance to the issue. */
  prSummary: z.string().optional(),
  recommendation: IssuePrRecommendationSchema,
});
export type IssuePrAnalysis = z.infer<typeof IssuePrAnalysisSchema>;

/**
 * The single structured verdict a validation session emits (parsed by the shared
 * `scans/shared/findings.ts` parse→ground→validate helpers). Flat-ish by design so
 * the codegen mirror stays inside its supported subset. `relatedFiles` are
 * repo-relative paths the engine GROUNDS against the checkout (a path that does not
 * resolve is dropped, never fails the run). `reasoning` / `proposedPlan` /
 * `prSummary` are model prose over attacker-controlled input (untrusted).
 *
 * This IS the payload of {@link import('./events.js')}'s `issue-validation-completed`
 * event, so it — and `IssuePrAnalysis` — are mirrored into `generated.rs`.
 */
export const IssueValidationResultSchema = z.object({
  issueKind: IssueKindSchema,
  verdict: IssueVerdictSchema,
  confidence: IssueConfidenceSchema,
  /** Why the model reached this verdict, grounded in the investigated code. */
  reasoning: z.string(),
  /** For bug reports: whether the model reproduced/confirmed the bug in the code. */
  bugConfirmed: z.boolean().optional(),
  /** Repo-relative paths the model grounded against the checkout (superset dropped
   *  to only-existing by the engine). */
  relatedFiles: z.array(z.string()).default([]),
  estimatedComplexity: IssueComplexitySchema.optional(),
  /** Step-by-step implementation plan (markdown), when the model proposes one. */
  proposedPlan: z.string().optional(),
  /** Populated when `verdict` is `needs_clarification`: what the issue is missing. */
  missingInfo: z.array(z.string()).default([]),
  prAnalysis: IssuePrAnalysisSchema.optional(),
});
export type IssueValidationResult = z.infer<typeof IssueValidationResultSchema>;

/**
 * A persisted validation record (one per validated issue, per project). Stored
 * Rust-side under `.nightcore/issue-validations/` via the generic `RunStore<R>`;
 * this zod shape is the frontend's view of it. Reopening the Issues view shows the
 * cached `result`; re-validation is an explicit action, badged stale when the
 * issue's `updatedAt` is newer than `validatedAt`. Not part of the engine NDJSON
 * protocol (not mirrored into `generated.rs`).
 */
export const IssueValidationSchema = z.object({
  issueNumber: z.number().int().positive(),
  /** The issue title AT validation time (untrusted; snapshotted for the history UI). */
  issueTitle: z.string(),
  /** ISO-8601 time the validation completed. */
  validatedAt: z.string(),
  /** The model that produced `result`. */
  model: z.string(),
  result: IssueValidationResultSchema,
  /** ISO-8601 time the user last opened this validation; absent until first viewed. */
  viewedAt: z.string().optional(),
});
export type IssueValidation = z.infer<typeof IssueValidationSchema>;
