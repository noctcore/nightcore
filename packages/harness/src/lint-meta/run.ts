/**
 * The lint-meta run loop + text reporter — a port of `tools/lint-meta/cli.ts`
 * (lines 69-118 semantics), minus the `--json` / `--update-baseline` machinery
 * the portable runner does not need.
 *
 * Run each rule's `run(ctx)`, capturing a throw as an outcome so ONE broken rule
 * never aborts the whole run. Reporting then folds the outcomes into printable
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

/** One rule's result: its violations, or the stringified error if it threw. */
export interface RuleOutcome {
  id: string;
  ciCritical: boolean;
  violations: IViolation[];
  /** The stringified throw when `run(ctx)` threw; `null` on a clean run. */
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

/**
 * Run every rule once, capturing a throw as an outcome (never aborting the run).
 * `onRule` fires just before each rule runs (legibility — the caller may echo it).
 */
export function runMetaRules(
  rules: IMetaRule[],
  ctx: IMetaCtx,
  onRule?: (rule: IMetaRule) => void,
): RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];
  for (const rule of rules) {
    onRule?.(rule);
    const ciCritical = rule.ciCritical === true;
    try {
      outcomes.push({ id: rule.id, ciCritical, violations: rule.run(ctx), threw: null });
    } catch (err) {
      outcomes.push({
        id: rule.id,
        ciCritical,
        violations: [],
        threw: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/**
 * Fold rule outcomes into a printable {@link MetaReport}. Violation lines match
 * the internal engine's format exactly: `[ERROR] <rule> (<file>): <message>` for
 * a critical rule, `[info] …` for a non-critical one. A throw is its own critical
 * line and always counts toward `criticalCount`.
 */
export function reportMetaOutcomes(outcomes: RuleOutcome[]): MetaReport {
  let criticalCount = 0;
  let totalViolations = 0;
  const lines: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.threw !== null) {
      lines.push(`[ERROR] ${outcome.id}: rule threw — ${outcome.threw}`);
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
