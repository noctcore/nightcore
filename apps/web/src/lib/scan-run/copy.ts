/**
 * View-model copy builders shared across the scan siblings (Insight / Harness /
 * Scorecard / PR-Review): the run-history menu, the collapsed-config summary
 * line, and the empty/failed state message. Each was cloned across the
 * `*View.hooks.ts` view models, differing only in the per-family nouns/copy that
 * these helpers take as parameters. Re-exported from the `@/lib/scan-run` barrel.
 */
import { formatRunReceipt } from '@/lib/formatters';

/** A run-history menu row. Structurally a subset of the shell's `MenuItem`
 *  (`@/components/ui`), re-declared here so `lib/` stays below the component
 *  layer — a value of this type assigns freely to a `MenuItem` field. */
export interface RunHistoryItem {
  label: string;
  onClick: () => void;
}

/** The run fields the history label reads: the receipt cost/duration plus the
 *  creation timestamp. Every persisted `*Run` satisfies this (a superset). */
export interface RunReceiptFields {
  /** Run creation time (epoch ms), rendered via `toLocaleString()`. */
  createdAt: number;
  /** Total run cost in USD (transcript-approximated). */
  costUsd: number;
  /** Total run duration in ms (`0` when none was recorded). */
  durationMs: number;
}

/** What a single run contributes to its history row: the count clause (the only
 *  part that differs between families — "12 findings" / "5 graded" /
 *  "3 conventions") and the click handler (reset transient state + select run). */
export interface RunHistoryEntry {
  /** The middle label segment, e.g. `"12 findings"`. */
  count: string;
  /** What selecting this run does. */
  onSelect: () => void;
}

/**
 * Build a scan's run-history menu (newest run first is the caller's ordering):
 * `"<local time> · <count> · <receipt>"` per run, with the count clause and
 * click handler supplied by `describe`. Cloned byte-for-byte across the Insight,
 * Scorecard, and Harness view models — they differed only in the count-noun and
 * which `selectRun` the click drives, both now parameters.
 */
export function buildRunHistory<Run extends RunReceiptFields>(
  runs: readonly Run[],
  describe: (run: Run) => RunHistoryEntry,
): RunHistoryItem[] {
  return runs.map((run) => {
    const { count, onSelect } = describe(run);
    return {
      label: `${new Date(run.createdAt).toLocaleString()} · ${count} · ${formatRunReceipt(
        run.costUsd,
        run.durationMs,
      )}`,
      onClick: onSelect,
    };
  });
}

/**
 * The collapsed-config summary line the scan shells render in their summary bar:
 * the target glyph followed by the pre-assembled parts joined with a middot.
 * Byte-identical in the Insight and Harness config summaries; the caller owns the
 * `parts` array (model / effort / scope / count clause) since it varies per family.
 */
export function buildScanSummary(parts: readonly string[]): string {
  return `⌖ ${parts.join(' · ')}`;
}

/** The per-family copy the empty/failed state message interpolates. */
export interface ScanEmptyVerbs {
  /** No run yet — the call-to-action prompt. */
  idle: string;
  /** The run is in flight (e.g. `"Analyzing…"`). */
  running: string;
  /** The run was cancelled (`failureReason === 'aborted'`). */
  aborted: string;
  /** The failed-run prefix, e.g. `"Analysis failed"` → `"Analysis failed: <error>."`. */
  failed: string;
  /** A completed run with nothing to show — the clean-bill copy. */
  empty: string;
}

/**
 * The scan empty/failed state message state machine, re-implemented across four
 * `*View.hooks.ts` view models (Insight / Scorecard / Harness / PR-Review) with
 * per-family copy but identical branching: idle → running → failed (aborted vs
 * errored) → else (clean). The Harness clone had DRIFTED, dropping the aborted
 * branch; routing it through here restores `verbs.aborted` for a cancelled scan.
 *
 * PR-Review keys its idle state off a null display stream rather than an `idle`
 * status, so it passes `status: displayStream?.status ?? 'idle'` (a registry
 * stream is never `idle`, so a present stream never mis-fires the idle branch).
 */
export function scanEmptyMessage(opts: {
  /** The stream's lifecycle status; `idle` selects the call-to-action prompt. */
  status: string;
  /** The failure cause, if any — `'aborted'` picks the cancelled copy. */
  failureReason: string | null | undefined;
  /** The failure detail appended to the failed prefix, or `null`. */
  error: string | null;
  verbs: ScanEmptyVerbs;
}): string {
  const { status, failureReason, error, verbs } = opts;
  if (status === 'idle') return verbs.idle;
  if (status === 'running') return verbs.running;
  if (status === 'failed') {
    if (failureReason === 'aborted') return verbs.aborted;
    return `${verbs.failed}${error !== null ? `: ${error}` : ''}.`;
  }
  return verbs.empty;
}
