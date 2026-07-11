import { z } from 'zod';

/**
 * `@nightcore/contracts` — one-shot RuleTester validation shapes (issue #185, item 1).
 *
 * The Harness arm gate proves an armed lint-plugin check is *wired* into the target
 * repo's ESLint config; this runner answers the stronger question — is the armed
 * check a REAL rule that actually fires, not a placebo? It loads a plugin rule and
 * runs it through ESLint's `RuleTester` on demand, returning a structured pass /
 * fail / probe / error verdict.
 *
 * The runner lives in the Bun sidecar (`@nightcore/engine`), NOT the Rust desktop
 * crate: a Rust-spawned bare `node` can't load the TS/ESM/CJS rules Nightcore ships,
 * and `RuleTester`'s constructor API varies across ESLint versions — the sidecar has
 * the toolchain to load the target project's own rules against its own ESLint. The
 * request rides the `validate-rule` {@link SurfaceQuery}; the result is the
 * `ruleValidation` slot of the correlated `query-result` event. Zod-only: imports
 * nothing app-specific so `events.ts` can reference the result without a cycle.
 */

/** Which suite a per-case result belongs to (a RuleTester `valid`/`invalid` case). */
export const RuleTesterCaseKindSchema = z.enum(['valid', 'invalid']);
export type RuleTesterCaseKind = z.infer<typeof RuleTesterCaseKindSchema>;

/**
 * The overall verdict of a validation run:
 *   - `passed`   — the rule loaded and every provided case ran as RuleTester expects.
 *   - `failed`   — the rule loaded but at least one case failed (a valid case reported,
 *                  or an invalid case did not fire / fired differently). The rule is
 *                  real but the supplied cases don't match its behavior.
 *   - `probed`   — no cases were supplied; the rule loaded and RuleTester accepted it as
 *                  a well-formed rule (structural "is this a real rule?" confirmation).
 *   - `error`    — the runner could not load the rule or the ESLint toolchain (soft
 *                  failure — reported structurally, never a thrown crash).
 */
export const RuleValidationOutcomeSchema = z.enum([
  'passed',
  'failed',
  'probed',
  'error',
]);
export type RuleValidationOutcome = z.infer<typeof RuleValidationOutcomeSchema>;

/** One RuleTester test case's outcome, so the UI can point at exactly which case
 *  (by suite + index) failed and show RuleTester's assertion message. */
export const RuleTesterCaseResultSchema = z.object({
  kind: RuleTesterCaseKindSchema,
  /** 0-based index within its suite (the position in `validCases`/`invalidCases`). */
  index: z.number().int().nonnegative(),
  /** Whether RuleTester accepted the case. */
  passed: z.boolean(),
  /** RuleTester's assertion message when the case failed (absent when it passed). */
  message: z.string().optional(),
});
export type RuleTesterCaseResult = z.infer<typeof RuleTesterCaseResultSchema>;

/**
 * The structured verdict of one `validate-rule` run. Carried on the `ruleValidation`
 * slot of a `query-result`; the Rust core single-sources it from the engine so the
 * desktop never re-implements RuleTester loading. `ruleLoaded` distinguishes a rule
 * that could not be resolved at all (`error` + `ruleLoaded: false`) from a rule that
 * loaded but whose cases failed (`failed` + `ruleLoaded: true`).
 */
export const RuleValidationResultSchema = z.object({
  /** Echoes the requested rule id, for UI keying / reporting. */
  ruleId: z.string(),
  outcome: RuleValidationOutcomeSchema,
  /** Whether the rule module resolved to a well-formed ESLint rule (has `create`). */
  ruleLoaded: z.boolean(),
  /** The ESLint version whose RuleTester ran the validation (diagnostic), when known. */
  eslintVersion: z.string().optional(),
  /** How many `valid` cases passed / were supplied. */
  validPassed: z.number().int().nonnegative().default(0),
  validTotal: z.number().int().nonnegative().default(0),
  /** How many `invalid` cases passed / were supplied. */
  invalidPassed: z.number().int().nonnegative().default(0),
  invalidTotal: z.number().int().nonnegative().default(0),
  /** Per-case detail (empty for a pure structural probe). */
  cases: z.array(RuleTesterCaseResultSchema).default([]),
  /** Set on a load/setup failure (`outcome: 'error'`): the reason, never a crash. */
  error: z.string().optional(),
});
export type RuleValidationResult = z.infer<typeof RuleValidationResultSchema>;
