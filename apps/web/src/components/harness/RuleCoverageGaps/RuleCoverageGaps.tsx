/** The Rule-Coverage-Gaps panel — the ENFORCE signal rendered below the conventions
 *  grid in the Enforce destination. For each observed convention it shows two joined
 *  answers, keyed on `conventionFingerprint`:
 *    · COVERAGE — is there a RULE for it? (`enforced` / `documented-only` / `unenforced`)
 *    · DRIFT    — is it FOLLOWED at every site? (`clean` / `drifted` / `errored` /
 *                 `uncheckable`), measured by an EnforceRun executing its armed check.
 *
 *  NON-NEGOTIABLE product rule: a `clean`/`drifted` chip ALWAYS renders `method` +
 *  `X/Y sites`. A convention with no armed check is `uncheckable` (honest — never a
 *  fake "clean"); before any EnforceRun the panel reads "not measured yet". */
import { COVERAGE_STATUS_META, DRIFT_STATUS_META } from '../harness.constants';
import type { RuleCoverageGapVM } from '../harness.types';
import { useRuleCoverageGaps } from './RuleCoverageGaps.hooks';
import type {
  CoverageDriftRow,
  DriftCell,
  RuleCoverageGapsProps,
} from './RuleCoverageGaps.types';
import { DRIFT_STATUS_WITH_COUNTS } from './RuleCoverageGaps.types';

/** One summary tally chip (e.g. "3 enforced"). */
function Tally({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-2xs">
      <span className={`font-semibold tabular-nums ${tone}`}>{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** The coverage-status detail line for one convention. */
function coverageDetail(gap: RuleCoverageGapVM): string {
  if (gap.status === 'enforced' && gap.enforcedBy.length > 0) {
    return `enforced by ${gap.enforcedBy.join(', ')}`;
  }
  if (gap.status === 'documented-only' && gap.documentedIn.length > 0) {
    return `documented: ${gap.documentedIn[0]}`;
  }
  if (gap.suggestedArtifactKind !== null) {
    return `propose a ${gap.suggestedArtifactKind} to enforce it`;
  }
  return 'no rule or agent-doc covers it';
}

/** Resolve a drift cell into the chip meta + detail line to render, or `null` when
 *  drift is unmeasured (no EnforceRun yet — the header note covers it, not the row).
 *  `clean`/`drifted` ALWAYS carry `method` + `X/Y sites` (the product rule). */
function driftDisplay(
  cell: DriftCell,
): { meta: (typeof DRIFT_STATUS_META)[keyof typeof DRIFT_STATUS_META]; detail: string } | null {
  if (cell.kind === 'unmeasured') return null;
  if (cell.kind === 'derived') {
    return {
      meta: DRIFT_STATUS_META.uncheckable,
      detail: 'no armed check measures this convention',
    };
  }
  const d = cell.drift;
  const meta = DRIFT_STATUS_META[d.status];
  if (DRIFT_STATUS_WITH_COUNTS.has(d.status)) {
    // Fail-visible: method + counts are mandatory for clean/drifted.
    return { meta, detail: `${d.method} · ${d.sitesMatched}/${d.sitesChecked} sites` };
  }
  if (d.status === 'errored') {
    const reason = d.errorReason ?? 'check output could not be parsed into counts';
    return { meta, detail: `${reason} · via ${d.method}` };
  }
  // A recorded `uncheckable` — carry its method if the check named one.
  return { meta, detail: d.method !== '' ? d.method : 'no armed check measures this convention' };
}

/** The drift chip + detail sub-line for one convention row (nothing when unmeasured). */
function DriftLine({ cell }: { cell: DriftCell }) {
  const display = driftDisplay(cell);
  if (display === null) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <span
        title={display.meta.hint}
        className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-4xs-plus font-semibold uppercase tracking-[0.04em] ${display.meta.chip} ${display.meta.tone}`}
      >
        {display.meta.label}
      </span>
      <span className="truncate font-mono text-3xs-plus text-muted-foreground">
        {display.detail}
      </span>
    </div>
  );
}

/** The coverage-status badge + detail line + the joined drift line for one convention. */
function CoverageRow({ row }: { row: CoverageDriftRow }) {
  const { gap, cell } = row;
  const meta = COVERAGE_STATUS_META[gap.status];

  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <span
        title={meta.hint}
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold ${meta.chip} ${meta.tone}`}
      >
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs-plus text-foreground">{gap.title}</p>
        <p className="truncate text-2xs text-muted-foreground">{coverageDetail(gap)}</p>
        <DriftLine cell={cell} />
      </div>
    </div>
  );
}

/** The coverage + drift panel. Renders nothing when the run carries no coverage (a
 *  pre-coverage run, or a scan with no conventions). */
export function RuleCoverageGaps({ gaps, drift }: RuleCoverageGapsProps) {
  const { summary, driftSummary, ordered, driftMeasured, hasCoverage } = useRuleCoverageGaps(
    gaps,
    drift,
  );
  if (!hasCoverage) return null;

  // The inventory line, kept a single string so it renders as one text node.
  const inventoryLine = `${summary.enforcingRuleCount} enforcing ${
    summary.enforcingRuleCount === 1 ? 'rule' : 'rules'
  } found`;

  return (
    <section
      aria-label="Rule coverage"
      className="flex max-h-[38vh] min-h-0 flex-col border-t border-border bg-white/[0.01]"
    >
      <header className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
            Rule coverage
          </span>
          <Tally label="enforced" count={summary.enforced} tone={COVERAGE_STATUS_META.enforced.tone} />
          <Tally
            label="documented only"
            count={summary.documentedOnly}
            tone={COVERAGE_STATUS_META['documented-only'].tone}
          />
          <Tally
            label="unenforced"
            count={summary.unenforced}
            tone={COVERAGE_STATUS_META.unenforced.tone}
          />
        </div>
        {driftMeasured ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
              Drift
            </span>
            <Tally label="clean" count={driftSummary.clean} tone={DRIFT_STATUS_META.clean.tone} />
            <Tally
              label="drifted"
              count={driftSummary.drifted}
              tone={DRIFT_STATUS_META.drifted.tone}
            />
            <Tally
              label="errored"
              count={driftSummary.errored}
              tone={DRIFT_STATUS_META.errored.tone}
            />
            <Tally
              label="uncheckable"
              count={driftSummary.uncheckable}
              tone={DRIFT_STATUS_META.uncheckable.tone}
            />
          </div>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          Coverage answers whether a rule <em>exists</em> for each convention ({inventoryLine});
          drift answers whether it is <em>followed</em> at every site.{' '}
          {driftMeasured
            ? 'Drift is measured by running the armed checks — clean/drifted always show the method + site counts.'
            : 'Conformance not measured yet — arm a check on the Harden stage, then run the armed checks to measure drift.'}
        </p>
      </header>
      <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
        {ordered.map((row) => (
          <CoverageRow key={row.gap.id} row={row} />
        ))}
      </div>
    </section>
  );
}
