import { z } from 'zod';

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

/** ONE severity scale for every lens. Ordered low→high for global ranking. Shares
 *  its value-set with the Insight severity scale (they collapse to one generated Rust
 *  enum). */
export const ReviewSeveritySchema = z.enum([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

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
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
