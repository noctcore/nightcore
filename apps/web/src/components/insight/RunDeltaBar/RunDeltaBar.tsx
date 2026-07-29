/** The Insight RESULTS run-over-run delta strip (issue #403): "4 new · 3 resolved ·
 *  5 persisting" against the previous COMPARABLE run — or a plain sentence saying
 *  why there is nothing comparable to diff against.
 *
 *  The caveat is rendered as VISIBLE text, not tucked into a tooltip. These counts
 *  are a fingerprint set-diff, so a finding whose title was reworded between runs
 *  reads as one "resolved" plus one "new"; a user who reads the numbers must see
 *  that in the same glance. Grounded lineage (a real `previousFindingId` fed
 *  through the scan passes) is v0.5 work — until then the word is "apparent". */
import { Badge, HistoryIcon } from '@/components/ui';

import type { InsightDeltaBlocker } from '../insight-delta';
import type { RunDeltaBarProps } from './RunDeltaBar.types';

/** Why no comparison is shown — one sentence per gate, so the user learns what
 *  WOULD make two runs comparable instead of just seeing a blank. */
const BLOCKER_COPY: Record<InsightDeltaBlocker, string> = {
  'no-earlier-run': 'No earlier analysis of this project to compare against yet.',
  'run-not-diffable':
    'This run is not comparable — a run-over-run diff needs a completed, whole-repo run of known depth that actually spent tokens.',
  'no-comparable-run':
    'No comparable previous run — every earlier analysis used a different scope, category set, or depth, and diffing across those would invent changes.',
};

/** Render the apparent delta (or its absence). Pure presentational. */
export function RunDeltaBar({ result, previousRunLabel, className }: RunDeltaBarProps) {
  if (result.kind !== 'delta') {
    return (
      <p
        className={`flex items-start gap-2 text-xs-flat text-muted-foreground ${className ?? ''}`}
      >
        <HistoryIcon size={13} className="mt-0.5 shrink-0 opacity-70" />
        {BLOCKER_COPY[result.blocker]}
      </p>
    );
  }

  const { apparentNew, apparentResolved, persisting, previousRunModel, modelChanged } =
    result.delta;
  const age =
    previousRunLabel !== null && previousRunLabel !== '' ? ` (${previousRunLabel})` : '';

  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <HistoryIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="text-xs-plus text-foreground">
          Apparent change vs previous run{age}
        </span>
        <Badge tone="warning">{apparentNew} new</Badge>
        <Badge tone="success">{apparentResolved} resolved</Badge>
        <Badge tone="neutral">{persisting} persisting</Badge>
      </div>
      <p className="max-w-[70ch] text-2xs leading-snug text-muted-foreground">
        Apparent, not verified: findings are matched by content fingerprint (file +
        title), not by engine lineage — a finding reworded between runs reads as one
        resolved plus one new.
        {modelChanged
          ? ` That run also used a different model (${previousRunModel}), which changes what gets found.`
          : ''}
      </p>
    </div>
  );
}
