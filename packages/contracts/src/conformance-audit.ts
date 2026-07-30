import { z } from 'zod';

import { ConventionDriftSchema } from './harness-enforce.js';

/**
 * `@nightcore/contracts` — the DEEP CONFORMANCE AUDIT shapes (issue #279).
 *
 * Drift v1 measures conformance MECHANICALLY: an armed lint-meta / ESLint check is
 * executed and its per-rule counts become a {@link ConventionDriftSchema} record. That
 * covers only the conventions a deterministic check can express; everything else stays
 * honestly `uncheckable`.
 *
 * The deep audit is the expensive other half — an LLM pass that RE-READS the sites for
 * those unmechanizable conventions. The pure-LLM variant of drift was killed on cost
 * ($30–95/run re-reading every site), so this one is **opt-in and bounded**: the caller
 * names the conventions to audit (capped), the pass runs read-only with a turn/budget
 * ceiling, and the result is folded into the same drift plane as the mechanical
 * records — carrying `method: "deep-audit: …"` so a reader can always tell a MEASURED
 * count from a MODEL-JUDGED one.
 *
 * The pass FAILS VISIBLY, never silently: a convention the model could not ground is
 * returned as `errored` with a reason, so the panel's non-negotiable rule (no
 * `clean`/`drifted` without a method + site counts) holds for LLM records too.
 *
 * Zod-only: imports nothing app-specific beyond `harness-enforce.ts` (itself
 * dependency-free), so `events.ts` can reference the result without a cycle.
 */

/** One convention handed to the audit: enough for the model to recognize it in code. */
export const ConformanceAuditTargetSchema = z.object({
  /** The convention's `category | normalized-title` sha1 — the join key back to drift. */
  fingerprint: z.string(),
  /** The convention's lens (a `ConventionCategory` wire string). */
  category: z.string(),
  /** The convention restated as the rule to verify. */
  title: z.string(),
  /** What the convention requires, in the scan's own words. */
  description: z.string().default(''),
});
export type ConformanceAuditTarget = z.infer<typeof ConformanceAuditTargetSchema>;

/**
 * The structured verdict of one deep conformance audit, carried on the
 * `conformanceAudit` slot of a `query-result`. `drift` holds one
 * {@link ConventionDriftSchema} per AUDITED convention (never more — the engine drops
 * any record whose fingerprint was not requested, so a hallucinated convention can
 * never enter the drift plane).
 *
 * Fails SOFT like the RuleTester runner: a pass that could not run at all reports
 * `error` with an empty `drift`, so the reply stays `ok: true` and the caller renders
 * a diagnostic rather than crashing.
 */
export const ConformanceAuditResultSchema = z.object({
  /** One drift record per audited convention (`method` always `deep-audit: <model>`). */
  drift: z.array(ConventionDriftSchema).default([]),
  /** The model that performed the audit (echoed into each record's `method`). */
  model: z.string().default(''),
  /** What the pass cost, in USD — surfaced so the opt-in's price is never invisible. */
  costUsd: z.number().default(0),
  /** Why the pass produced nothing / degraded (absent on a clean run). */
  error: z.string().optional(),
});
export type ConformanceAuditResult = z.infer<typeof ConformanceAuditResultSchema>;
