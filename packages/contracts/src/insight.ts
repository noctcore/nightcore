import { z } from 'zod';

import { runTotals, scanFailure, TokenUsageSchema } from './event-fragments.js';
import { type Severity, SeveritySchema } from './severity.js';

/**
 * `@nightcore/contracts` — Insight (codebase analysis) shapes.
 *
 * The Insight feature runs Claude over a project as a set of read-only category
 * passes that each emit STRUCTURED findings (not a free-text dump and not a
 * file round-trip — the engine validates each finding against {@link FindingSchema}
 * and grounds its file refs before streaming it). One unified severity scale and
 * one unified effort scale span every category so findings sort/filter/rank
 * globally; per-category nuance lives in the optional fields, never in a
 * per-category vocabulary.
 *
 * Zod-only: this module imports nothing from `commands.ts`/`events.ts` so those
 * can import {@link FindingSchema} / {@link FindingCategorySchema} without a cycle.
 */

/** The analysis categories. Each is one read-only pass and one UI tab. The wire
 *  strings are kebab-case so `ui-ux` survives codegen as a clean enum variant. */
export const FindingCategorySchema = z.enum([
  'architecture',
  'bugs',
  'refactor',
  'performance',
  'security',
  'tests',
  'docs',
  'ui-ux',
  'dependencies',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/** ONE severity scale for every category (fixes the per-category vocab drift in
 *  Aperant's Ideation). Ordered low→high for global ranking.
 *
 *  The scale itself is declared ONCE in `severity.ts` and shared with PR-review's
 *  `ReviewSeveritySchema` and the web's badge palette (issue #178); this is the
 *  Insight-facing NAME for it, kept so every call site, docstring, and the
 *  generated Rust `FindingSeverity` resolve unchanged. */
export const FindingSeveritySchema = SeveritySchema;
export type FindingSeverity = Severity;

/** ONE effort scale for every category — the estimated work to address a finding. */
export const FindingEffortSchema = z.enum([
  'trivial',
  'small',
  'medium',
  'large',
]);
export type FindingEffort = z.infer<typeof FindingEffortSchema>;

/** Where a finding lives. `file` is a repo-relative path the engine GROUNDS
 *  (verifies it exists; a finding whose file does not resolve is dropped). Lines
 *  are 1-based and clamped to the file length so the UI can deep-link to a real
 *  range. `symbol` names the function/type/component when the model identifies one. */
export const FindingLocationSchema = z.object({
  file: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbol: z.string().optional(),
});
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/**
 * One grounded finding. Flat by design — codegen handles nested objects/arrays
 * but NOT a discriminated union inside a struct, so per-category extras are plain
 * optional fields rather than a tagged variant. The lifecycle fields (status,
 * linkedTaskId) are NOT here: they are owned by the Rust `InsightStore`, applied
 * on persist. The wire `Finding` is the engine's analysis output only.
 */
export const FindingSchema = z.object({
  /** Stable id assigned by the engine (used for dedup, convert-to-task, UI keys). */
  id: z.string(),
  category: FindingCategorySchema,
  severity: FindingSeveritySchema,
  effort: FindingEffortSchema,
  /** One-line headline. */
  title: z.string(),
  /** What the issue is, concretely. */
  description: z.string(),
  /** Why it matters / the impact, when the model articulates one. */
  rationale: z.string().optional(),
  /** Grounded file:line anchor, when the finding is localizable. */
  location: FindingLocationSchema.optional(),
  /** Concrete recommended fix. */
  suggestion: z.string().optional(),
  /** Illustrative current snippet (code-quality/refactor findings). */
  codeBefore: z.string().optional(),
  /** Illustrative improved snippet. */
  codeAfter: z.string().optional(),
  /** All repo-relative files the finding touches (superset of `location.file`). */
  affectedFiles: z.array(z.string()).default([]),
  /** Free-form sub-tags (e.g. `duplication`, `n+1`, `cwe-89`). */
  tags: z.array(z.string()).default([]),
  /** Model self-rated confidence 0..1, when provided. */
  confidence: z.number().optional(),
  /** Stable content fingerprint (category + normalized file + title) used to carry
   *  dismissed-history across re-runs and to dedup across category passes. */
  fingerprint: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Whether a run sweeps the whole repo or only what changed. */
export const AnalysisScopeSchema = z.enum(['repo', 'diff']);
export type AnalysisScope = z.infer<typeof AnalysisScopeSchema>;

/**
 * Insight analysis events. These do NOT carry `sessionId` (the category passes are
 * internal to the engine's analysis orchestrator and never surface as ordinary
 * sessions); they correlate by `runId`. The Rust reader routes the whole
 * `analysis-*` family to the `nc:insight` channel and persists the run on
 * `analysis-completed`.
 */

/** A run started. Echoes the resolved categories/scope/model for the UI header. */
export const AnalysisStartedEvent = z.object({
  type: z.literal('analysis-started'),
  runId: z.string(),
  scope: AnalysisScopeSchema,
  categories: z.array(FindingCategorySchema),
  model: z.string(),
});

/** A category pass began exploring (the UI shows skeleton cards for it). */
export const AnalysisCategoryStartedEvent = z.object({
  type: z.literal('analysis-category-started'),
  runId: z.string(),
  category: FindingCategorySchema,
});

/** A category pass finished: its grounded findings stream in as a batch, plus the
 *  pass's own token usage and cost so the UI can show per-category spend. */
export const AnalysisCategoryCompletedEvent = z.object({
  type: z.literal('analysis-category-completed'),
  runId: z.string(),
  category: FindingCategorySchema,
  findings: z.array(FindingSchema),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): findings is then empty and the
   *  UI marks the category errored rather than "0 findings". */
  error: z.string().optional(),
});

/** An intermediate DEEP-mode event (issue #294): one ROUND of a category's
 *  multi-round loop finished. Carries the 1-based round index, how many NET-NEW
 *  (post-dedup) findings this round contributed, the CUMULATIVE grounded findings for
 *  the category so far, and this round's OWN cost/usage (per-round, not cumulative).
 *  The Rust reader persists the cumulative set per ROUND via the same
 *  `accumulate_findings` path `analysis-category-completed` uses, so a multi-hour
 *  category that crashes keeps every prior round's paid findings. Emitted ONLY for
 *  deep runs; a classic single-pass run emits `analysis-category-completed` instead. */
export const AnalysisCategoryRoundCompletedEvent = z.object({
  type: z.literal('analysis-category-round-completed'),
  runId: z.string(),
  category: FindingCategorySchema,
  /** 1-based round index within this category's deep loop. */
  round: z.number().int().positive(),
  /** Net-new grounded findings this round added (post-dedup vs prior rounds). */
  newFindingsThisRound: z.number().int().nonnegative(),
  /** The cumulative grounded findings for this category across all rounds so far. */
  findings: z.array(FindingSchema),
  ...runTotals,
});

/** The whole run finished: the final cross-category-deduped findings plus run
 *  totals. The Rust reader persists from THIS event (authoritative). */
export const AnalysisCompletedEvent = z.object({
  type: z.literal('analysis-completed'),
  runId: z.string(),
  findings: z.array(FindingSchema),
  categoriesRun: z.array(FindingCategorySchema),
  ...runTotals,
});

/** The run failed before completing (could not start, or aborted). */
export const AnalysisFailedEvent = z.object({
  type: z.literal('analysis-failed'),
  runId: z.string(),
  ...scanFailure,
});
