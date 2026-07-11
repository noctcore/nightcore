/** A compact one-line readout of a scan run's persisted cost / tokens / duration /
 *  model — the receipt that used to vanish the moment the RUNNING screen ended.
 *  Rendered on the scan RESULTS screens (Insight / Scorecard / Harness) and any
 *  surface that has a finished run's usage. Cost is APPROXIMATE (computed from the
 *  run's transcript, matching the Trust Report precedent) so it is prefixed `≈`. */
import { formatCostUsd, formatDurationMs, formatTokensCompact } from '@/lib/formatters';

/** Props for {@link RunUsageLine}. Every field is optional-shaped so a run with no
 *  recorded usage still renders (fail-open to a labelled "—") rather than throwing. */
interface RunUsageLineProps {
  /** The model the run used; `null`/empty ⇒ "default". */
  model: string | null;
  /** Approximate total run cost in USD (from the transcript). */
  costUsd: number;
  /** Input/output token totals for the run. */
  usage: { inputTokens: number; outputTokens: number };
  /** Wall-clock run duration in ms; `0` ⇒ omitted. */
  durationMs: number;
  /** Extra classes for the wrapper (spacing at the call site). */
  className?: string;
}

/** Render `⌖ model · ≈$cost · N tok · duration`. Missing/zero pieces are dropped
 *  individually so a partial run (e.g. cost recorded but no duration) still reads
 *  cleanly. Pure presentational — never fetches, never throws on absent numbers. */
export function RunUsageLine({
  model,
  costUsd,
  usage,
  durationMs,
  className,
}: RunUsageLineProps) {
  const totalTokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  const parts: string[] = [];
  parts.push(model !== null && model.trim().length > 0 ? model : 'default');
  parts.push(Number.isFinite(costUsd) ? `≈ ${formatCostUsd(Math.max(0, costUsd))}` : '≈ —');
  if (totalTokens > 0) parts.push(`${formatTokensCompact(totalTokens)} tok`);
  if (durationMs > 0) parts.push(formatDurationMs(durationMs));

  return (
    <div
      className={`flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground ${className ?? ''}`}
    >
      <span aria-hidden className="text-muted-foreground/70">
        ⌖
      </span>
      <span className="tabular-nums">{parts.join(' · ')}</span>
    </div>
  );
}
