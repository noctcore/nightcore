import { z } from 'zod';

/**
 * `@nightcore/contracts` — Harness ENFORCE-lite shapes (rule-coverage detection).
 *
 * Phase-1 ENFORCE ships **coverage, not conformance**: for each observed
 * convention it reports whether an enforcing lint/meta rule covers it
 * (`enforced`), an agent doc merely claims it (`documented-only`), or nothing
 * does (`unenforced`). It does NOT yet check whether a convention is FOLLOWED at
 * every site — that is Phase-2 "convention drift". Coverage is computed by a cheap
 * deterministic rule-inventory extraction plus one no-tool LLM join in the Harness
 * scan's `finalize`, and rides the existing `harness-scan-completed` event
 * additively (see {@link HarnessScanCompletedEvent} in `harness.ts`).
 *
 * The stable join key is the convention's `conventionFingerprint` (the
 * `category | normalized-title` sha1 the engine already assigns, `findings.ts`),
 * so these shapes never need a migration when drift arrives — a `ConventionDrift`
 * record (Phase 2) will key on the same fingerprint. Zod-only: this file imports
 * nothing else in the contract spine (in particular NOT `harness.ts`), so
 * `harness.ts` can import `RuleCoverageGapSchema` for its completed-event field
 * without a cycle.
 */

/**
 * A convention's enforcement coverage status. Wire strings are kebab-case so they
 * survive codegen as a clean `CoverageStatus` Rust enum (`rename_all = "kebab-case"`).
 *   - `enforced`        — a lint/meta rule (or armed gauntlet check) covers it.
 *   - `documented-only` — an agent doc (CLAUDE.md / AGENTS.md) claims it, but no
 *                         rule enforces it (the `agent-contract-parity` insight
 *                         inverted: docs without teeth).
 *   - `unenforced`      — neither a rule nor a doc covers it.
 */
export const CoverageStatusSchema = z.enum([
  'enforced',
  'documented-only',
  'unenforced',
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/**
 * One convention's enforcement-coverage report — exactly one record per
 * convention, keyed on `conventionFingerprint`. Flat and lifecycle-free (coverage
 * is recomputed every scan; there is no user-editable state to persist), so it
 * codegens to a lean Rust struct. Mirrors the `ConventionFinding` shape's discipline:
 * enum-ish `category` rides as a bare wire string (kept lenient here to avoid a
 * `harness.ts` import cycle; the web casts it to `ConventionCategory`).
 */
export const RuleCoverageGapSchema = z.object({
  /** Stable id assigned by the engine (`coverage-<conventionFingerprint>`; UI keys). */
  id: z.string(),
  /** The convention this covers — its `category | normalized-title` sha1 (the join key). */
  conventionFingerprint: z.string(),
  /** The convention's lens (a `ConventionCategory` wire string; the web casts it). */
  category: z.string(),
  /** The convention, restated as the rule that was checked for coverage. */
  title: z.string(),
  status: CoverageStatusSchema,
  /** Enforcing rule ids that cover it (`nightcore/no-cross-feature-imports`, a
   *  lint-meta id, an armed gauntlet-check name). Empty unless `status === 'enforced'`. */
  enforcedBy: z.array(z.string()).default([]),
  /** Agent-doc claim lines that mention it (guardrail heading / rule-name text).
   *  Populated for `documented-only`. */
  documentedIn: z.array(z.string()).default([]),
  /** What synthesis (PROPOSE) could generate to close the gap — an `ArtifactKind`
   *  wire string, kept lenient (never trusted as a hard enum). */
  suggestedArtifactKind: z.string().optional(),
  /** Stable fingerprint — the `conventionFingerprint` (one coverage record per
   *  convention), so acknowledged-coverage carry-forward can key on it later. */
  fingerprint: z.string(),
});
export type RuleCoverageGap = z.infer<typeof RuleCoverageGapSchema>;

/**
 * A convention's measured conformance status — the Phase-2 "drift" answer that
 * {@link RuleCoverageGapSchema} deliberately does NOT give (coverage answers "is
 * there a rule?", drift answers "is it FOLLOWED at every site?"). Produced only by
 * executing a human-armed check; the non-negotiable product rule is that
 * `clean`/`drifted` are NEVER rendered without a `method` + site counts.
 *   - `clean`       — an armed check ran and found 0 violating sites (render WITH
 *                     method + counts, never as a bare "clean").
 *   - `drifted`     — an armed check ran and found N>0 violating sites.
 *   - `uncheckable` — no armed check covers this convention (the HONEST state — a
 *                     convention with no check is not "clean").
 *   - `errored`     — the check could not run, or its output could not be parsed
 *                     into counts (fail-visible, not silently "clean").
 * Kebab-free lowercase wire strings → a clean `ConventionDriftStatus` Rust enum.
 */
export const ConventionDriftStatusSchema = z.enum([
  'clean',
  'drifted',
  'uncheckable',
  'errored',
]);
export type ConventionDriftStatus = z.infer<typeof ConventionDriftStatusSchema>;

/**
 * One convention's measured drift, the output of an EnforceRun executing its armed
 * check. A SEPARATE additive record from {@link RuleCoverageGapSchema}, joined to it
 * in the UI by `conventionFingerprint` — the SAME key ENFORCE-lite's coverage record
 * reserved (its header says "a `ConventionDrift` record (Phase 2) will key on the
 * same fingerprint"), so coverage + drift join with zero migration. Flat and
 * lifecycle-free like coverage; `method` + `sitesMatched`/`sitesChecked` are always
 * carried so the UI can honor the fail-visible product rule (`sitesChecked: 0` ⇒
 * counts unknown ⇒ NOT `clean`).
 */
export const ConventionDriftSchema = z.object({
  /** Stable id assigned by the engine (`drift-<conventionFingerprint>`; UI keys). */
  id: z.string(),
  /** The convention this measures — its `category | normalized-title` sha1 (the join key). */
  conventionFingerprint: z.string(),
  /** The convention's lens (a `ConventionCategory` wire string; the web casts it). */
  category: z.string(),
  /** The convention, restated as the rule the armed check verifies. */
  title: z.string(),
  status: ConventionDriftStatusSchema,
  /** ALWAYS rendered: the check name + tool/rule id that determined this (e.g.
   *  `lint-meta: folder-per-component` or `shell: rg -c 'export default'`). */
  method: z.string(),
  /** Violating sites the armed check reported. */
  sitesMatched: z.number().default(0),
  /** Sites the armed check examined (`0` ⇒ counts unknown → can never be `clean`). */
  sitesChecked: z.number().default(0),
  /** The armed check that produced this drift record, when known. */
  checkName: z.string().optional(),
  /** Populated for `errored` — why the check could not run / parse. */
  errorReason: z.string().optional(),
  /** Stable fingerprint — `== conventionFingerprint` (carry-forward key, v0.4). */
  fingerprint: z.string(),
});
export type ConventionDrift = z.infer<typeof ConventionDriftSchema>;
