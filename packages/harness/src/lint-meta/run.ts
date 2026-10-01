/**
 * The lint-meta run loop + text reporter — a port of `tools/lint-meta/cli.ts`
 * (lines 69-118 semantics), minus the `--json` / `--update-baseline` machinery
 * the portable runner does not need.
 *
 * Run each rule's `run(ctx)` and/or `runAsync(ctx)`, capturing a throw or a
 * rejection as an outcome so ONE broken rule never aborts the whole run. Reporting then folds the outcomes into printable
 * lines + counts:
 *  - a rule that THROWS is itself a CRITICAL failure (fail-safe: a broken rule in
 *    a foreign CI reds the build, it never silently passes). This HARDENS the
 *    internal engine, which only counted a throw as critical when the rule was
 *    `ciCritical`; a portable runner cannot afford a silently-skipped broken rule.
 *  - a violation from a `ciCritical` rule is `[ERROR]` and critical; from a
 *    non-critical rule it is `[info]` and does not fail the build.
 *
 * The runner exits 1 iff {@link MetaReport.criticalCount} > 0, else 0.
 */
import type { IMetaCtx, IMetaRule, IViolation } from './types.js';

/** Which entry point produced an outcome. */
export type RulePass = 'sync' | 'async';

/** One rule pass's result: its violations, or the stringified error if it failed. */
export interface RuleOutcome {
  id: string;
  ciCritical: boolean;
  /** `sync` for `run(ctx)`, `async` for `runAsync(ctx)`. */
  pass: RulePass;
  violations: IViolation[];
  /** The stringified throw/rejection when the pass failed; `null` on a clean run. */
  threw: string | null;
}

/** The folded, printable report over a run's outcomes. */
export interface MetaReport {
  /** Count of failures that must red the build (critical violations + throws). */
  criticalCount: number;
  /** Count of ALL emitted violations (critical + info), excluding throws. */
  totalViolations: number;
  /** The lines to print (violation + throw lines), in rule order. */
  lines: string[];
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A pass must hand back an ARRAY. A sync `run` that returns a Promise (an async
 * rule declared under the wrong entry point) would otherwise reach the reporter
 * as a non-iterable and crash the whole run; name the fix instead.
 */
function checkViolations(pass: RulePass, value: unknown): IViolation[] {
  if (Array.isArray(value)) return value as IViolation[];
  if (pass === 'sync' && typeof (value as { then?: unknown } | null)?.then === 'function') {
    throw new Error('run() returned a Promise; declare an async rule as runAsync(ctx)');
  }
  const entry = pass === 'sync' ? 'run()' : 'runAsync()';
  throw new Error(`${entry} must return an array of violations, got ${typeof value}`);
}

/**
 * Run every rule once, in registry order, capturing a throw or a rejection as an
 * outcome (never aborting the run). A rule with both entry points runs `run`
 * then `runAsync`, each isolated, and yields one outcome per pass. Async rules
 * are awaited one at a time, so the report order is deterministic.
 * `onRule` fires just before each rule runs (legibility, the caller may echo it).
 */
export async function runMetaRules(
  rules: IMetaRule[],
  ctx: IMetaCtx,
  onRule?: (rule: IMetaRule) => void,
): Promise<RuleOutcome[]> {
  const outcomes: RuleOutcome[] = [];
  for (const rule of rules) {
    onRule?.(rule);
    const base = { id: rule.id, ciCritical: rule.ciCritical === true };
    // Called as methods, not destructured, so a rule that reads `this` still works.
    if (rule.run !== undefined) {
      try {
        const violations = checkViolations('sync', rule.run(ctx));
        outcomes.push({ ...base, pass: 'sync', violations, threw: null });
      } catch (err) {
        outcomes.push({ ...base, pass: 'sync', violations: [], threw: describeError(err) });
      }
    }
    if (rule.runAsync !== undefined) {
      try {
        const violations = checkViolations('async', await rule.runAsync(ctx));
        outcomes.push({ ...base, pass: 'async', violations, threw: null });
      } catch (err) {
        outcomes.push({ ...base, pass: 'async', violations: [], threw: describeError(err) });
      }
    }
  }
  return outcomes;
}

/**
 * Fold rule outcomes into a printable {@link MetaReport}. Violation lines match
 * the internal engine's format exactly: `[ERROR] <rule> (<file>): <message>` for
 * a critical rule, `[info] …` for a non-critical one. A throw (or an async
 * rejection) is its own critical line and always counts toward
 * `criticalCount`.
 */
export function reportMetaOutcomes(outcomes: RuleOutcome[]): MetaReport {
  let criticalCount = 0;
  let totalViolations = 0;
  const lines: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.threw !== null) {
      const verb = outcome.pass === 'async' ? 'rejected' : 'threw';
      lines.push(`[ERROR] ${outcome.id}: rule ${verb} — ${outcome.threw}`);
      criticalCount += 1;
      continue;
    }
    for (const v of outcome.violations) {
      totalViolations += 1;
      const tag = outcome.ciCritical ? 'ERROR' : 'info';
      lines.push(`[${tag}] ${v.rule} (${v.file}): ${v.message}`);
      if (outcome.ciCritical) criticalCount += 1;
    }
  }

  return { criticalCount, totalViolations, lines };
}

/** The process exit code a report implies: 1 on any critical failure, else 0. */
export function exitCodeFor(report: MetaReport): number {
  return report.criticalCount > 0 ? 1 : 0;
}
