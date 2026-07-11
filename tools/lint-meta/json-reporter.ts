// @ts-check
/**
 * lint-meta `--json` reporter — the machine-readable output mode.
 *
 * This is an INTEGRATION CONTRACT (Drift v1 slice 2 / EnforceRun, spec
 * `docs/research/2026-07-11-drift-v1-spec.md`): EnforceRun runs an armed lint-meta
 * check with `--json`, parses this payload, and turns each rule's count into a
 * convention's `sitesMatched`. Treat the shape below as a wire contract — extend
 * it ADDITIVELY only (never rename/remove a field).
 *
 * Emitted JSON shape (see {@link JsonReport}):
 *
 *   {
 *     "violations": [               // one entry per reported violation, across all rules
 *       {
 *         "ruleId":   string,       // == IMetaRule.id (== IViolation.rule)
 *         "filePath": string,       // repo-relative POSIX path (== IViolation.file)
 *         "message":  string,
 *         "line"?:    number,       // 1-indexed; PRESENT only when the rule pinpoints a
 *         "column"?:  number        //   location — OMITTED (never null) otherwise
 *       }
 *     ],
 *     "counts":  { [ruleId]: number },  // EVERY rule that ran, INCLUDING 0. A consumer
 *                                       // never re-tallies `violations`; a ran-clean rule
 *                                       // (0) is distinguishable from one that errored or
 *                                       // is absent from the registry.
 *     "errored": string[],          // ruleIds whose run threw — EXCLUDED from `counts`
 *                                    // (fail-visible: unrunnable ⇒ NOT reported as clean).
 *     "total":   number             // sum of every rule's count (== violations.length)
 *   }
 *
 * The CLI writes this on `--json` and exits 0 (like `--update-baseline`): the
 * payload — not the exit code — carries pass/fail, so a machine consumer parses
 * stdout without treating a violation as a process failure. The default text
 * reporter keeps the CI gate's non-zero exit and is unaffected by this mode.
 */
import type { IViolation } from './types';

/** One rule's execution outcome, as the CLI collects it before reporting. */
export interface RuleOutcome {
  /** The rule's id (== IMetaRule.id). */
  id: string;
  /** Violations the rule reported (empty when it ran clean). */
  violations: IViolation[];
  /** Non-null when the rule threw — the id is listed in `errored`, not `counts`. */
  error: string | null;
}

/** A single violation in the machine-readable payload. */
export interface JsonViolation {
  ruleId: string;
  filePath: string;
  message: string;
  /** 1-indexed source location; omitted (never null) when the rule reports none. */
  line?: number;
  column?: number;
}

/** The `--json` payload. Stable wire contract — extend additively only. */
export interface JsonReport {
  violations: JsonViolation[];
  counts: Record<string, number>;
  errored: string[];
  total: number;
}

/**
 * Fold per-rule outcomes into the machine-readable {@link JsonReport}. Pure — no
 * I/O — so the CLI shell and the tests share one code path.
 */
export function buildJsonReport(outcomes: RuleOutcome[]): JsonReport {
  const violations: JsonViolation[] = [];
  const counts: Record<string, number> = {};
  const errored: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.error !== null) {
      // A rule that threw could not produce counts — fail-visible, never "clean".
      errored.push(outcome.id);
      continue;
    }
    counts[outcome.id] = outcome.violations.length;
    for (const v of outcome.violations) {
      const entry: JsonViolation = {
        ruleId: v.rule,
        filePath: v.file,
        message: v.message,
      };
      // Omit line/column entirely when absent — never emit nulls that a consumer
      // would have to filter before counting.
      if (typeof v.line === 'number') entry.line = v.line;
      if (typeof v.column === 'number') entry.column = v.column;
      violations.push(entry);
    }
  }

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { violations, counts, errored, total };
}
