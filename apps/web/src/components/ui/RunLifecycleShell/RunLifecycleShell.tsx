/** Shared frame for the configure/running/results lifecycle screens. */
import { usePhaseFade, usePhaseFocus } from './RunLifecycleShell.hooks';
import type { RunLifecycleShellProps, RunPhase } from './RunLifecycleShell.types';

/** Spoken phase name for the screen-reader live region (view-agnostic). */
const PHASE_LABEL: Record<RunPhase, string> = {
  configure: 'Configure',
  running: 'Running',
  results: 'Results',
};

/**
 * The presentational frame both the Insight and Harness views wrap their three
 * lifecycle screens (CONFIGURE / RUNNING / RESULTS) in. It owns the header row
 * and the collapsed-config summary bar; each view owns the screen bodies it
 * passes as `children` and the slots it fills (`summary`, `actions`).
 *
 * Pure presentational — the only behavior is a 150ms opacity cross-fade between
 * phases (see `usePhaseFade`), which respects `prefers-reduced-motion`.
 */
export function RunLifecycleShell({
  title,
  subtitle,
  phase,
  summary,
  actions,
  children,
}: RunLifecycleShellProps) {
  const opacity = usePhaseFade(phase);
  const bodyRef = usePhaseFocus(phase);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Announce the lifecycle phase to screen readers on each swap — the visible
          transition is a silent opacity fade. Updates only on phase CHANGE. */}
      <span role="status" aria-live="polite" className="sr-only">
        {PHASE_LABEL[phase]} screen
      </span>
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          {subtitle !== undefined && (
            <span className="truncate text-[12px] text-muted-foreground">{subtitle}</span>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      {phase !== 'configure' && summary !== undefined && (
        <div className="border-b border-border bg-white/[0.015] px-6 py-2.5 font-mono text-[11px] text-muted-foreground">
          {summary}
        </div>
      )}

      {/* The body is itself a flex column so a screen root declaring
          `min-h-0 flex-1` (the configure/results screens of every consumer)
          actually receives a constrained height — without `flex` here those
          declarations are inert, the screen grows past the viewport, and its
          inner `overflow-y-auto` panes never engage (the unscrollable-PR-view
          dogfood bug). `h-full` screen roots (Harness) resolve either way. */}
      <div
        ref={bodyRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none transition-opacity duration-150 ease-out"
        style={{ opacity }}
      >
        {children}
      </div>
    </div>
  );
}
