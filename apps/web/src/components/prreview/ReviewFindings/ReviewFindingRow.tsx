/** One finding card in the PR Review results grid: a selection checkbox above the
 *  shared {@link DetailCard} chrome (severity + lens badges, corroboration chip,
 *  grounded file:line, inert body). */
import { Checkbox, DetailCard } from '@/components/ui';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';

/** Format a review finding's grounded location as `file:line` (or `file` when the
 *  finding is not line-localizable). */
function formatReviewLocation(finding: ReviewFindingView): string {
  return finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
}

/** One finding card: the selection checkbox above the shared card chrome
 *  (severity + lens badges, corroboration chip, grounded file:line, inert body). */
export function ReviewCard({
  finding,
  selected,
  recurring,
  onToggleSelect,
  onOpen,
}: {
  finding: ReviewFindingView;
  selected: boolean;
  recurring: boolean;
  onToggleSelect: (findingId: string) => void;
  onOpen: (finding: ReviewFindingView) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = LENS_META[finding.lens];
  const Icon = Meta.icon;
  const dimmed = finding.status !== 'open';
  const corroborated = finding.corroboratedBy.length > 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Selection lives OUTSIDE the DetailCard button (which is itself
          interactive) so toggling it never opens the detail panel. Dismissed
          findings can't be posted, so their checkbox is disabled. */}
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelect(finding.id)}
        label="Include in review"
        disabled={finding.status === 'dismissed'}
      />
      <DetailCard
        onClick={() => onOpen(finding)}
        dimmed={dimmed}
        hoverTitle={
          dimmed
            ? finding.status === 'converted'
              ? 'Converted to task'
              : 'Dismissed'
            : undefined
        }
        title={finding.title}
        location={formatReviewLocation(finding)}
        description={finding.body}
        badges={
          <>
            <span
              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${sev.chip} ${sev.tone}`}
            >
              {sev.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              <Icon size={11} />
              {Meta.label}
            </span>
            {/* Corroboration: other lenses independently surfaced this issue —
                a compact "also: security, tests" chip (fuller labels on hover). */}
            {corroborated && (
              <span
                className="inline-flex items-center rounded-md border border-primary/25 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                title={`Also surfaced by: ${finding.corroboratedBy
                  .map((l) => LENS_META[l].label)
                  .join(', ')}`}
              >
                also: {finding.corroboratedBy.join(', ')}
              </span>
            )}
            {/* Carried over from the previous review (follow-up comparison) —
                subtle, so it never competes with the severity/lens badges. */}
            {recurring && finding.status === 'open' && (
              <span className="inline-flex items-center rounded-md border border-warning/30 bg-warning/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-medium text-warning/90">
                still open
              </span>
            )}
            {finding.status === 'converted' && (
              <span className="ml-auto rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
                task
              </span>
            )}
            {finding.status === 'dismissed' && (
              <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                dismissed
              </span>
            )}
          </>
        }
      />
    </div>
  );
}
