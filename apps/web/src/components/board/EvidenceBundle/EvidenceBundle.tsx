/** The review-time Evidence bundle (wayfinder T8). Staged inside the Result band
 *  when a task is parked for review, it assembles the per-task receipt the reviewer
 *  needs to Accept/Reject in ONE place: the gauntlet result verbatim, the worktree
 *  diff stats, the guardrail ledger, and the (approximate) cost — reusing the Trust
 *  Report's presentational sections so the review-time view and the post-merge Trust
 *  band read identically. Read-only; never re-runs anything. */
import { TrustSections, TrustSummary } from '../TrustReport';
import { useEvidenceBundle } from './EvidenceBundle.hooks';
import type { EvidenceBundleProps, EvidenceDiffStat } from './EvidenceBundle.types';

/** The worktree diff totals line (files changed + added/deleted lines vs base). A
 *  `null` diff (unfetched / non-worktree) shows a quiet note; a zero-file diff is
 *  stated explicitly so an empty change set never looks like a fetch failure. */
function DiffStatLine({ diff }: { diff: EvidenceDiffStat | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="font-mono text-3xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Diff
      </span>
      {diff === null ? (
        <span className="text-muted-foreground">Diff stats unavailable.</span>
      ) : diff.files === 0 ? (
        <span className="text-muted-foreground">No file changes vs base.</span>
      ) : (
        <span className="text-foreground">
          {diff.files} file{diff.files === 1 ? '' : 's'} ·{' '}
          <span className="font-mono text-success">+{diff.additions}</span>{' '}
          <span className="font-mono text-destructive">&minus;{diff.deletions}</span>
        </span>
      )}
    </div>
  );
}

/** The review evidence bundle. Fetches the receipt + diff (fail-open), then renders
 *  the compact summary, the diff stats (worktree tasks only), and the full receipt
 *  sections. A still-loading / unavailable / errored fetch degrades to a note; the
 *  bundle never blocks the review controls above it. */
export function EvidenceBundle({ task, data }: EvidenceBundleProps) {
  const { report, diff, loading, unavailable, error } = useEvidenceBundle(task, data);

  return (
    <section
      aria-label="Review evidence"
      className="space-y-3 rounded-md border border-border bg-white/[0.02] px-3 py-3"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          Evidence
        </h3>
        <span className="text-3xs text-muted-foreground/70">
          the receipt for this decision · cost is approximate
        </span>
      </div>

      {report === null ? (
        <p className="text-sm text-muted-foreground">
          {loading
            ? 'Assembling the evidence…'
            : error != null
              ? `Evidence unavailable: ${error}`
              : unavailable
                ? 'Evidence is unavailable in the browser preview.'
                : 'No evidence recorded yet.'}
        </p>
      ) : (
        <div className="space-y-3">
          <TrustSummary report={report} />
          {task.runMode === 'worktree' && <DiffStatLine diff={diff} />}
          <TrustSections report={report} />
        </div>
      )}
    </section>
  );
}
