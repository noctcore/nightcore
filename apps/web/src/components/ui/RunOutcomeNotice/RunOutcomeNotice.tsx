/** A scan RESULTS-screen notice for a run that ended without completing cleanly:
 *  a neutral inset card for a user cancel (`aborted`), or a destructive one for a
 *  `failed` run. The Insight, Scorecard, and Harness results screens all render
 *  this identical card (previously three divergent inline treatments — two inset
 *  cards and a border-b strip). The failed variant always carries the reassurance
 *  that whatever streamed before the failure is still shown below. */

export interface RunOutcomeNoticeProps {
  /** `aborted` = a user cancel (neutral); `failed` = the run errored (destructive). */
  kind: 'aborted' | 'failed';
  /** The lead sentence. For `aborted`, the full neutral message; for `failed`, the
   *  error / summary line — the reassurance line is appended automatically. */
  message: string;
  /** Extra classes for call-site spacing (e.g. `mx-6 mt-5`). */
  className?: string;
}

/** Render the inset outcome card. Pure presentational. */
export function RunOutcomeNotice({ kind, message, className }: RunOutcomeNoticeProps) {
  const failed = kind === 'failed';
  return (
    <div
      className={`rounded-nc border px-4 py-3 text-xs-plus ${
        failed
          ? 'border-destructive/40 bg-destructive/[0.08] text-destructive'
          : 'border-border bg-white/[0.02] text-muted-foreground'
      } ${className ?? ''}`}
    >
      {message}
      {failed && (
        <span className="mt-1 block text-destructive/80">
          Any findings that streamed before the failure are shown below.
        </span>
      )}
    </div>
  );
}
