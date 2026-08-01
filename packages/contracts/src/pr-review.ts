import { z } from 'zod';

import { runTotals, TokenUsageSchema } from './event-fragments.js';
import { type Severity, SeveritySchema } from './severity.js';

/**
 * `@nightcore/contracts` — PR Review (GitHub pull-request review) shapes.
 *
 * The fourth scan sibling (alongside Insight / Harness / Scorecard). It reviews a
 * GitHub pull request of the current project as a set of read-only per-LENS passes
 * that each emit STRUCTURED findings grounded against the PR's changed-file set
 * (DIFF-relative, not disk-relative — a PR that adds `new.rs` has no `new.rs` in the
 * current checkout, so disk-grounding would wrongly drop it). One unified severity
 * scale spans every lens so findings sort/filter/rank globally.
 *
 * Zod-only: this module imports nothing from `commands.ts`/`events.ts` so those can
 * import {@link ReviewFindingSchema} / {@link ReviewLensSchema} without a cycle.
 *
 * NAMING: the eslint `zod-schema-naming` rule (error on contracts) carves out only
 * `Event|Command|Query` suffixes; the finding schema is deliberately named
 * `ReviewFindingSchema` (NOT `...Command/Event/Query`) so the rule does not fire.
 */

/** The review lenses. Each is one read-only pass and one UI focus. The wire strings
 *  are single lowercase words so they survive codegen as clean enum variants. */
export const ReviewLensSchema = z.enum([
  'security',
  'logic',
  'structure',
  'tests',
  'contracts',
]);
export type ReviewLens = z.infer<typeof ReviewLensSchema>;

/** ONE severity scale for every lens. Ordered low→high for global ranking.
 *
 *  It is LITERALLY the Insight severity scale, not merely a matching value-set: both
 *  are now aliases of the single `severity.ts` declaration (issue #178), which is
 *  what the generated Rust already assumed — the emitter keys enums by value-set, so
 *  `ReviewSeverity` and `FindingSeverity` have always collapsed to one Rust enum.
 *  The alias is kept so every call site and docstring resolves unchanged. */
export const ReviewSeveritySchema = SeveritySchema;
export type ReviewSeverity = Severity;

/** The overall MERGE VERDICT the synthesis pass assigns to the whole PR after every
 *  lens + the adversarial validator have run — one coarse recommendation spanning all
 *  findings, ordered mergeable → blocked. Emitted additively + optionally on the wire
 *  (see the `pr-review-completed` event): a run whose synthesis pass errors/times-out/
 *  cancels completes WITHOUT it (fail-open), and an older engine that never runs the
 *  pass simply omits it. Named `MergeVerdictSchema` (NOT `...Command/Event/Query`) so
 *  the `zod-schema-naming` rule does not fire — same carve-out as the finding schema. */
export const MergeVerdictSchema = z.enum([
  'ready',
  'merge_with_changes',
  'needs_revision',
  'blocked',
]);
export type MergeVerdict = z.infer<typeof MergeVerdictSchema>;

/**
 * One grounded PR-review finding. Flat (codegen can't do a tagged union inside a
 * struct). Lifecycle fields (status, linkedTaskId) are NOT here — owned Rust-side by
 * the `PrReviewStore`, applied on persist. The wire `ReviewFinding` is the engine's
 * review output only.
 */
export const ReviewFindingSchema = z.object({
  /** Stable id assigned by the engine (used for dedup, convert-to-task, UI keys). */
  id: z.string(),
  lens: ReviewLensSchema,
  severity: ReviewSeveritySchema,
  /** Repo-relative path; MUST be a changed file in the PR (diff-relative grounding). */
  file: z.string(),
  /** 1-based line in the PR head, when localizable. */
  line: z.number().int().positive().optional(),
  /** One-line headline. */
  title: z.string(),
  /** What the issue is, concretely. */
  body: z.string(),
  /** Concrete recommended fix, when the model articulates one. */
  suggestedFix: z.string().optional(),
  /** Stable content fingerprint (lens + normalized file + title) for dedup +
   *  dismissed-history across re-runs. */
  fingerprint: z.string(),
  /** Review lenses OTHER than {@link ReviewFindingSchema.shape.lens} that independently
   *  surfaced this same issue — populated by the cross-lens dedup when it collapses
   *  duplicate findings, so the corroborating signal survives the merge instead of
   *  being dropped. Additive + optional; absent when only the reporting lens found it. */
  corroboratedBy: z.array(ReviewLensSchema).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * PR Review events (the fourth scan sibling). Like the `analysis-*` family these carry
 * no `sessionId` and correlate by `runId`; the Rust reader routes the whole
 * `pr-review-*` family to the `nc:pr-review` channel and persists the run on
 * `pr-review-completed`. Each lens pass emits a batch of grounded findings over the PR
 * diff. `pr-review-finding-converted` is a Rust-emitted notice on the same channel (the
 * convert-to-task acknowledgement), part of the union so surfaces can narrow it.
 */

/** A run started. Echoes the resolved lenses/model for the UI header. */
export const PrReviewStartedEvent = z.object({
  type: z.literal('pr-review-started'),
  runId: z.string(),
  lenses: z.array(ReviewLensSchema),
  model: z.string(),
});

/** A lens pass began reviewing (the UI shows skeleton cards for it). */
export const PrReviewLensStartedEvent = z.object({
  type: z.literal('pr-review-lens-started'),
  runId: z.string(),
  lens: ReviewLensSchema,
});

/** A lens pass finished: its grounded findings stream in as a batch, plus the pass's
 *  own token usage and cost so the UI can show per-lens spend. */
export const PrReviewLensCompletedEvent = z.object({
  type: z.literal('pr-review-lens-completed'),
  runId: z.string(),
  lens: ReviewLensSchema,
  findings: z.array(ReviewFindingSchema),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): findings is then empty and the UI
   *  marks the lens errored rather than "0 findings". */
  error: z.string().optional(),
});

/** An intermediate DEEP-mode event (issue #294): one ROUND of a review lens's
 *  multi-round loop finished. Mirrors {@link import('./insight.js').AnalysisCategoryRoundCompletedEvent}
 *  exactly, shaped for the PR review: the 1-based round index, how many NET-NEW
 *  (post-dedup) findings this round contributed, the CUMULATIVE diff-grounded findings
 *  for the lens so far, and this round's OWN cost/usage (per-round, not cumulative). The
 *  Rust reader persists the cumulative set per ROUND via the same `accumulate_findings`
 *  path `pr-review-lens-completed` uses. Because the review is DIFF-BOUNDED, the loop
 *  self-limits — it converges in a round or two rather than open-endedly. Emitted ONLY
 *  for deep runs; a classic single-pass run emits `pr-review-lens-completed` instead. */
export const PrReviewRoundCompletedEvent = z.object({
  type: z.literal('pr-review-round-completed'),
  runId: z.string(),
  lens: ReviewLensSchema,
  /** 1-based round index within this lens's deep loop. */
  round: z.number().int().positive(),
  /** Net-new diff-grounded findings this round added (post-dedup vs prior rounds). */
  newFindingsThisRound: z.number().int().nonnegative(),
  /** The cumulative diff-grounded findings for this lens across all rounds so far. */
  findings: z.array(ReviewFindingSchema),
  ...runTotals,
});

/** The whole run finished: the final cross-lens-deduped findings plus run totals. The
 *  Rust reader persists from THIS event (authoritative). `lensesRun` is the count of
 *  lens passes that ran. */
export const PrReviewCompletedEvent = z.object({
  type: z.literal('pr-review-completed'),
  runId: z.string(),
  findings: z.array(ReviewFindingSchema),
  lensesRun: z.number().int().nonnegative(),
  ...runTotals,
  /** The synthesis pass's overall merge recommendation for the PR. Additive +
   *  optional (FAIL-OPEN): a synthesis pass that errors/times-out/cancels completes
   *  the run WITHOUT it, and an older engine that never runs the pass omits it. */
  verdict: MergeVerdictSchema.optional(),
  /** The synthesis pass's short (~120-word) justification for {@link verdict}. Present
   *  only when `verdict` is; same fail-open/additive posture. */
  verdictReasoning: z.string().optional(),
  /** True when the mechanical severity→verdict CLAMP overrode the model's proposed
   *  verdict: {@link verdict} above is then the clamped (mechanically-banded) value,
   *  not the model's raw pick. Additive + optional: absent when the model's proposal
   *  was already inside the allowed band, when no verdict was produced (fail-open), or
   *  from an older engine. */
  verdictClamped: z.boolean().optional(),
  /** The human-readable reason the verdict was clamped — recorded ONLY alongside
   *  {@link verdictClamped} = true (e.g. a `high`-severity finding floored the verdict
   *  at `needs_revision`). Surfaces WHY the mechanical band overrode the model so the
   *  clamp is transparent rather than silent. */
  clampReason: z.string().optional(),
  /** The candidate findings the ADVERSARIAL VALIDATOR judged unsupported by the diff
   *  and DROPPED — the ones that never reach {@link findings}. Surfaced so a
   *  silently-swallowed real finding is visible (the validator is fail-open by design,
   *  but a clean-looking drop-list is exactly where a true positive disappears without
   *  a trace). Additive + optional: absent when the validator dropped nothing, when it
   *  degraded (fail-open keeps everything), or from an older engine. Display-only —
   *  dropped findings take no part in the verdict, the clamp, or the posted review. */
  droppedFindings: z.array(ReviewFindingSchema).optional(),
});

/** The run failed before completing (could not start, or aborted). `reason` is a free
 *  string (the manager's failure code) so a surface degrades on drift. */
export const PrReviewFailedEvent = z.object({
  type: z.literal('pr-review-failed'),
  runId: z.string(),
  reason: z.string(),
  message: z.string(),
});

/** A finding was converted into a board task. Emitted by the Rust convert command on
 *  the `nc:pr-review` channel (mirrors Insight's convert notice), not by the engine. */
export const PrReviewFindingConvertedEvent = z.object({
  type: z.literal('pr-review-finding-converted'),
  runId: z.string(),
  findingId: z.string(),
  taskId: z.string(),
});
