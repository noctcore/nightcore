import { z } from 'zod';

import { FindingLocationSchema } from './insight.js';

/**
 * `@nightcore/contracts` — Readiness Scorecard shapes (the Profile twin of Insight).
 *
 * Where Insight runs read-only category passes that emit many severity-ranked
 * {@link Finding}s, the Scorecard runs one read-only pass PER production dimension
 * (architecture, tests, security, …) that emits a single grounded
 * {@link ScorecardReading}: an A–F grade for that dimension plus the evidence the
 * grade rests on. The grade is the headline; the evidence is what keeps it honest
 * (the engine grounds every evidence file ref before streaming it, exactly like
 * Insight). Each reading carries a `hardenSkill` provenance so the UI's
 * "Harden this" button can mint a Build task whose prompt is the dimension's
 * slash-command (e.g. `/security-audit`).
 *
 * Zod-only: imports nothing from `commands.ts`/`events.ts` so those can import
 * {@link ScorecardReadingSchema} / {@link ScorecardDimensionSchema} without a cycle.
 * It DOES import {@link FindingLocationSchema} from `insight.ts` (also zod-only) so
 * the grounded location shape is shared, not re-declared.
 */

/** The production-readiness dimensions. Each is one read-only grading pass and one
 *  UI row. Wire strings are kebab-case so `error-handling`/`docs-ci` survive codegen
 *  as clean enum variants (`ErrorHandling`/`DocsCi`). */
export const ScorecardDimensionSchema = z.enum([
  'architecture',
  'tests',
  'security',
  'error-handling',
  'observability',
  'dependencies',
  'performance',
  'types',
  'a11y',
  'docs-ci',
]);
export type ScorecardDimension = z.infer<typeof ScorecardDimensionSchema>;

/** ONE grade scale for every dimension — an A–F letter grade (A best, F worst).
 *  Ordered high→low for global ranking. The rubric thresholds that map evidence to
 *  a letter are pinned per-dimension in the engine's `scorecard-presets.ts`, so the
 *  model picks the letter against fixed criteria rather than freestyling it. */
export const ScorecardGradeSchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F']);
export type ScorecardGrade = z.infer<typeof ScorecardGradeSchema>;

/** One grounded piece of evidence under a reading. `detail` is the concrete
 *  observation; `location` is the repo-relative anchor the engine GROUNDS (a
 *  hallucinated file ref is stripped to a fileless evidence line, never deep-linked
 *  to a path that does not exist). */
export const ScorecardEvidenceSchema = z.object({
  /** The concrete observation backing (or docking) the grade. */
  detail: z.string(),
  /** Grounded file:line anchor, when the evidence is localizable. */
  location: FindingLocationSchema.optional(),
});
export type ScorecardEvidence = z.infer<typeof ScorecardEvidenceSchema>;

/**
 * One grounded reading for one dimension — the Scorecard's analogue of a
 * {@link Finding}, mirroring its flat, codegen-friendly shape MINUS severity/effort
 * (a dimension carries a `grade`, not a per-issue severity) PLUS `dimension`,
 * `grade`, and the `findings` evidence array. Flat by design: codegen handles
 * nested objects/arrays but not a discriminated union inside a struct. The
 * lifecycle fields (status, linkedTaskId) are NOT here: they are owned by the Rust
 * `ScorecardStore`, applied on persist. The wire `ScorecardReading` is the engine's
 * grading output only.
 */
export const ScorecardReadingSchema = z.object({
  /** Stable id assigned by the engine (used for convert-to-task, UI keys). */
  id: z.string(),
  dimension: ScorecardDimensionSchema,
  grade: ScorecardGradeSchema,
  /** One-line headline (e.g. "Solid coverage, gaps in error paths"). */
  title: z.string(),
  /** The graded assessment, concretely — what holds the dimension at this letter. */
  summary: z.string(),
  /** Why this grade / what would move it up a letter, when the model articulates it. */
  rationale: z.string().optional(),
  /** The primary grounded file:line anchor, when the reading localizes to one. */
  location: FindingLocationSchema.optional(),
  /** The single highest-leverage recommended action to raise the grade. */
  suggestion: z.string().optional(),
  /** All repo-relative files the reading touches (superset of `location.file`). */
  affectedFiles: z.array(z.string()).default([]),
  /** Free-form sub-tags (e.g. `coverage`, `cwe-89`, `n+1`). */
  tags: z.array(z.string()).default([]),
  /** The grounded evidence the grade rests on (0..N items). */
  findings: z.array(ScorecardEvidenceSchema).default([]),
  /** Model self-rated confidence 0..1, when provided. */
  confidence: z.number().optional(),
  /** Stable content fingerprint (dimension + normalized title) for UI keys. */
  fingerprint: z.string(),
});
export type ScorecardReading = z.infer<typeof ScorecardReadingSchema>;
