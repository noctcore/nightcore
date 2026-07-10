/** The Trust band's compact summary row — the at-a-glance verdict. */
import { formatUsd } from './TrustReport.hooks';
import type { TrustSectionProps } from './TrustReport.types';

/** A small labelled chip for the summary row. */
function Chip({ label, tone = 'muted' }: { label: string; tone?: 'success' | 'destructive' | 'muted' }) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'destructive'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <span
      className={`font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${toneClass}`}
    >
      {label}
    </span>
  );
}

/** The one-line receipt summary: verified pill · gauntlet pass/fail · denied/asked
 *  counts · sessions + cost. Every number traces to a persisted record. */
export function TrustSummary({ report }: TrustSectionProps) {
  const { gauntlet, guardrails, flight } = report;
  const lock = gauntlet.structureLock;
  const cost = flight.costUsdTotal ?? flight.costUsdLastRun ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Chip
        label={gauntlet.verified ? '✓ Verified' : '× Not verified'}
        tone={gauntlet.verified ? 'success' : 'destructive'}
      />
      {lock != null && (
        <Chip
          label={lock.passed ? 'Gauntlet passed' : `Gauntlet failed${lock.failedCheck != null ? ` · ${lock.failedCheck}` : ''}`}
          tone={lock.passed ? 'success' : 'destructive'}
        />
      )}
      <Chip
        label={`${guardrails.denied} denied · ${guardrails.asked} asked`}
        tone={guardrails.denied > 0 ? 'destructive' : 'muted'}
      />
      <Chip
        label={`${flight.sessionCount} session${flight.sessionCount === 1 ? '' : 's'}${cost != null ? ` · ${formatUsd(cost)}` : ''}`}
      />
    </div>
  );
}
