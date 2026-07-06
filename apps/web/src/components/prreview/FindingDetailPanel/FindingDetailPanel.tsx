/** The PR Review finding detail sheet, composed from the shared
 *  GroundedFindingBody. The finding body came from a review model, so it is
 *  rendered as INERT text (`descriptionInert`) — never through Markdown /
 *  dangerouslySetInnerHTML. The suggested fix is our own suggested code, shown
 *  in a read-only CodeBlock (`suggestionCode`). */
import {
  DetailSection,
  GroundedFindingBody,
  type GroundedFindingView,
  GroundedLifecycleFooter,
  inferLanguageFromFile,
} from '@/components/ui';
import type { ReviewLens } from '@/lib/bridge';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

/** Join corroborating lens labels into an Oxford-comma prose list. */
function formatLensList(lenses: ReviewLens[]): string {
  const labels = lenses.map((l) => LENS_META[l].label);
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** The finding detail sheet: the inert body, grounded location, suggested fix, and
 *  the lifecycle actions (convert / dismiss / restore). */
export function FindingDetailPanel({
  open,
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: FindingDetailPanelProps) {
  const render = (shown: ReviewFindingView): GroundedFindingView => {
    const sev = SEVERITY_META[shown.severity];
    const Meta = LENS_META[shown.lens];
    const Icon = Meta.icon;
    return {
      title: shown.title,
      badges: (
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
        </>
      ),
      footer: (
        <GroundedLifecycleFooter
          status={shown.status}
          pending={pending}
          onConvert={() => onConvert(shown.id)}
          onDismiss={() => onDismiss(shown.id)}
          onRestore={() => onRestore(shown.id)}
          onGotoBoard={onGotoBoard}
        />
      ),
      sections: {
        description: shown.body,
        descriptionInert: true,
        // Corroboration: the fuller counterpart to the card's "also:" chip —
        // which OTHER lenses independently surfaced this same issue.
        afterDescription: shown.corroboratedBy.length > 0 && (
          <DetailSection title="Corroboration">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Also independently surfaced by the{' '}
              {formatLensList(shown.corroboratedBy)}{' '}
              {shown.corroboratedBy.length === 1 ? 'lens' : 'lenses'}.
            </p>
          </DetailSection>
        ),
        location:
          shown.line !== null ? `${shown.file}:${shown.line}` : shown.file,
        suggestion: shown.suggestedFix,
        suggestionCode: true,
        language: inferLanguageFromFile(shown.file),
      },
    };
  };

  return (
    <GroundedFindingBody
      open={open}
      item={finding}
      onClose={onClose}
      render={render}
    />
  );
}
