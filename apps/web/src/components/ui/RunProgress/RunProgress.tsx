/** Live per-category progress panel for the running screen. */
import { CheckIcon, ChevronRightIcon } from '../icons';
import { StatusDot } from '../StatusDot';
import { useElapsedMs } from './RunProgress.hooks';
import type {
  CategoryRunState,
  RunProgressProps,
  RunProgressStatus,
} from './RunProgress.types';

const STATUS_META: Record<RunProgressStatus, { dot: string; label: string }> = {
  idle: { dot: 'bg-muted-foreground', label: 'idle' },
  running: { dot: 'bg-primary', label: 'running' },
  completed: { dot: 'bg-success', label: 'complete' },
  failed: { dot: 'bg-destructive', label: 'failed' },
};

/** A category counts as "finished" (filled in the overall bar) once it is no
 *  longer pending/running — whether it succeeded or errored. */
function isFinished(state: CategoryRunState): boolean {
  return state === 'done' || state === 'error';
}

/** Format a USD amount as `$0.00`. */
function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Format a token count compactly (e.g. `1.2k`, `34k`). */
function formatTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format an elapsed duration in ms as `m:ss`. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The RUNNING-screen progress panel — the antidote to "looked frozen." Fed an
 * identical, view-agnostic shape by both the Insight and Harness views: an
 * overall bar, a live `$cost · tok · elapsed` readout whose elapsed ticks every
 * 1s locally, one row per category, and (Harness) a synthesis row.
 *
 * Pure presentational. The view owns the surrounding Cancel control and the
 * partial-reveal grid that a `done`/`error` row's `onOpenCategory` triggers.
 */
export function RunProgress({
  status,
  categories,
  categoryState,
  findingCounts,
  unitLabel = 'lenses',
  synthesizing = false,
  costUsd,
  usage,
  durationMs,
  onOpenCategory,
}: RunProgressProps) {
  const elapsedMs = useElapsedMs(status === 'running', durationMs);

  const total = categories.length;
  const finished = categories.filter(
    (category) => isFinished(categoryState[category.key] ?? 'pending'),
  ).length;
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const statusMeta = STATUS_META[status];

  return (
    <section aria-label="Run progress" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Run progress
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <StatusDot colorClass={statusMeta.dot} pulse={status === 'running'} />
          {statusMeta.label}
        </span>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-border bg-white/[0.015]">
        {/* Header: overall bar + live readout. */}
        <div className="flex items-center gap-4 border-b border-border px-4 py-3 font-mono text-[11px] text-muted-foreground">
          <div
            role="progressbar"
            aria-label="Overall progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${synthesizing ? 100 : pct}%` }}
            />
            {synthesizing && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                style={{ animation: 'nc-bar 1.4s ease-in-out infinite' }}
              />
            )}
          </div>
          {/* Discrete progress announcement. `role=status`/`aria-live=polite`
              voices each finished-count change (and synthesis) to screen readers.
              The elapsed readout below is deliberately OUTSIDE this region — it
              ticks every 1s and would otherwise spam announcements. */}
          <span role="status" aria-live="polite" className="shrink-0 tabular-nums">
            {finished} / {total} {unitLabel} · {pct}%
            {synthesizing && <span className="sr-only"> · Synthesizing…</span>}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatCostUsd(costUsd)} · {formatTokens(totalTokens)} tok · {formatElapsed(elapsedMs)}
          </span>
        </div>

        {/* One row per category. */}
        <div className="divide-y divide-border">
          {categories.map((category) => {
            const state = categoryState[category.key] ?? 'pending';
            const count = findingCounts[category.key] ?? 0;
            const Icon = category.icon;
            const clickable = isFinished(state) && onOpenCategory !== undefined;

            const indicator =
              state === 'done' ? (
                <CheckIcon size={13} className="text-primary" />
              ) : state === 'error' ? (
                <span className="font-semibold text-destructive">!</span>
              ) : state === 'running' ? (
                <StatusDot colorClass="bg-primary" pulse />
              ) : (
                <span className="text-muted-foreground/60">·</span>
              );

            const trailing =
              state === 'done' ? (
                <span className="tabular-nums text-foreground">
                  {count} {count === 1 ? 'finding' : 'findings'}
                </span>
              ) : state === 'error' ? (
                <span className="text-destructive">failed</span>
              ) : state === 'running' ? (
                <span className="truncate text-muted-foreground">scanning…</span>
              ) : (
                <span className="text-muted-foreground/60">queued</span>
              );

            const rowClass = `flex w-full items-center gap-3 px-4 py-2.5 text-left text-[12.5px] ${
              state === 'pending' ? 'opacity-60' : ''
            }`;
            const labelTone = state === 'pending' ? 'text-muted-foreground' : 'text-foreground';

            const content = (
              <>
                <span className="flex w-4 shrink-0 items-center justify-center">{indicator}</span>
                <Icon size={13} className="shrink-0 text-muted-foreground" />
                <span className={`flex-1 truncate ${labelTone}`}>{category.label}</span>
                <span className="shrink-0 font-mono text-[11px]">{trailing}</span>
              </>
            );

            return clickable ? (
              <button
                key={category.key}
                type="button"
                onClick={() => onOpenCategory?.(category.key)}
                className={`group ${rowClass} transition-colors hover:bg-white/[0.03]`}
              >
                {content}
                {/* Hover/focus affordance that the finished lens is openable —
                    the partial-reveal peek while other lenses still run. */}
                <ChevronRightIcon
                  size={14}
                  aria-hidden
                  className="-ml-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </button>
            ) : (
              <div key={category.key} className={rowClass} aria-busy={state === 'running'}>
                {content}
                {/* Reserve the chevron's footprint so trailing text right-aligns
                    consistently with the clickable (finished) rows. */}
                <span aria-hidden className="-ml-1 w-3.5 shrink-0" />
              </div>
            );
          })}
        </div>

        {/* Synthesis row (Harness only) — kills the dead-zone after every lens reads "done". */}
        {synthesizing && (
          <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[12.5px]">
            <span className="flex w-4 shrink-0 items-center justify-center">
              <StatusDot colorClass="bg-primary" pulse />
            </span>
            <span className="flex-1 text-foreground">Synthesizing harness…</span>
          </div>
        )}
      </div>
    </section>
  );
}
