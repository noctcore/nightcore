/** Presentational leaves of the Checks Manager panel — the last-run banner, the deep
 *  conformance-audit opt-in, and the two per-check result readouts. Split out of
 *  `ChecksManager.tsx` for the 400-line web file-size cap; all pure render, no state. */
import type { ArmedCheckOutcome, ArmedChecksLastRun, RuleValidationResult } from '@/lib/bridge';
import { formatRelativeTime } from '@/lib/formatters';

import type { ChecksRunVM } from './ChecksManager.types';

type OutcomeStatus = ArmedCheckOutcome['status'];

const STATUS_GLYPH: Record<OutcomeStatus, string> = {
  passed: '\u2713',
  failed: '\u2715',
  skipped: '\u2013',
  flaky: '~',
};

const STATUS_TEXT: Record<OutcomeStatus, string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
  flaky: 'text-warning',
};

export function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The run-level banner: pass/fail of the last on-demand run + when it ran. */
export function LastRunBanner({ lastRun }: { lastRun: ArmedChecksLastRun }) {
  return (
    <div className="flex items-center gap-2 text-2xs-plus">
      <span
        className={`font-mono font-semibold uppercase tracking-[0.06em] ${
          lastRun.passed ? 'text-success' : 'text-destructive'
        }`}
      >
        {lastRun.passed ? 'All passed' : `Failed at ${lastRun.failedCheck ?? 'unknown'}`}
      </span>
      <span className="text-muted-foreground">· ran {formatRelativeTime(lastRun.ranAt)} ago</span>
      {lastRun.deep && (
        <span className="font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground">
          · deep audit
        </span>
      )}
    </div>
  );
}

/** The DEEP conformance audit opt-in (#279). Off by default and stated in full BEFORE
 *  the run: the armed checks are free to re-run, the deep pass is a paid model read, so
 *  the price and the ceiling are on screen at the moment of choosing — never after. */
export function DeepAuditOptIn({ run }: { run: ChecksRunVM }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-2xs-plus text-muted-foreground">
      <input
        type="checkbox"
        className="mt-0.5 cursor-pointer accent-accent"
        checked={run.deep}
        disabled={run.running}
        onChange={(e) => run.setDeep(e.target.checked)}
      />
      <span>
        <span className="font-medium text-foreground">Also run a deep conformance audit</span> —
        re-reads the codebase with the model to judge the conventions no armed check can
        measure. The armed checks alone are free to re-run; this pass is paid, bounded to
        a ${run.deepBudgetUsd.toFixed(2)} ceiling and a capped set of conventions, and its
        results are labelled <span className="font-mono">deep-audit</span> so a judged
        verdict is never mistaken for a measured one.
      </span>
    </label>
  );
}

/** One check's last on-demand outcome: glyph + label + exit/duration + failure tail. */
export function CheckResult({ result }: { result: ArmedCheckOutcome }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 font-mono text-2xs">
        <span className={STATUS_TEXT[result.status]}>
          {STATUS_GLYPH[result.status]} {result.status}
        </span>
        {result.exitCode !== undefined && result.status === 'failed' && (
          <span className="text-destructive">exit {result.exitCode}</span>
        )}
        {result.durationMs !== undefined && (
          <span className="text-muted-foreground">{formatDurationMs(result.durationMs)}</span>
        )}
      </div>
      {result.output !== undefined && result.status !== 'passed' && (
        <pre className="max-h-32 overflow-auto rounded-[6px] border border-border bg-black/30 px-2 py-1.5 font-mono text-3xs-plus text-muted-foreground">
          {result.output}
        </pre>
      )}
    </div>
  );
}

type ValidationOutcome = RuleValidationResult['outcome'];

/** The tint per RuleTester verdict: a probe/pass is good, a failed rule is a hard
 *  fail, a load/setup error is a warning (the check may still be fine — the runner
 *  just couldn't reach the rule). */
const VALIDATION_TONE: Record<ValidationOutcome, string> = {
  passed: 'text-success',
  probed: 'text-success',
  failed: 'text-destructive',
  error: 'text-warning',
};

const VALIDATION_LABEL: Record<ValidationOutcome, string> = {
  passed: 'Rule validated',
  probed: 'Real rule (structural probe passed)',
  failed: 'Rule failed validation',
  error: 'Could not validate',
};

/** One check's last "Validate rule" verdict: the RuleTester outcome + case tally +
 *  any soft error the runner reported (a rule that wouldn't load, etc.). */
export function ValidationResult({ result }: { result: RuleValidationResult }) {
  const total = result.validTotal + result.invalidTotal;
  const passed = result.validPassed + result.invalidPassed;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 font-mono text-2xs">
        <span className={VALIDATION_TONE[result.outcome]}>
          {result.outcome === 'failed' || result.outcome === 'error' ? '✕' : '✓'}{' '}
          {VALIDATION_LABEL[result.outcome]}
        </span>
        {total > 0 && (
          <span className="text-muted-foreground">
            {passed}/{total} cases
          </span>
        )}
        {result.eslintVersion !== undefined && (
          <span className="text-muted-foreground">eslint {result.eslintVersion}</span>
        )}
      </div>
      {result.error !== undefined && (
        <pre className="max-h-32 overflow-auto rounded-[6px] border border-border bg-black/30 px-2 py-1.5 font-mono text-3xs-plus text-muted-foreground">
          {result.error}
        </pre>
      )}
    </div>
  );
}
