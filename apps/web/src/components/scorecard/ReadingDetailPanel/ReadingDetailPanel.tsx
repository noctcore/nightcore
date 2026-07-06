/** The Scorecard reading detail sheet, composed from the shared GroundedFindingBody. */
import {
  BuildIcon,
  Button,
  DetailSection,
  GroundedFindingBody,
  type GroundedFindingView,
  MoveIcon,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { DIMENSION_META, GRADE_META } from '../scorecard.constants';
import type { ScorecardReadingView } from '../scorecard.types';
import type { ReadingDetailPanelProps } from './ReadingDetailPanel.types';

/** The reading detail sheet: the big grade badge, the graded summary, what would
 *  raise it, the grounded evidence, and the single "Harden this" action that mints a
 *  Build task running the dimension's audit slash-command. No dismiss/restore. */
export function ReadingDetailPanel({
  open,
  reading,
  pending,
  onClose,
  onHarden,
  onGotoBoard,
}: ReadingDetailPanelProps) {
  const render = (shown: ScorecardReadingView): GroundedFindingView => {
    const Meta = DIMENSION_META[shown.dimension];
    const Icon = Meta.icon;
    const grade = GRADE_META[shown.grade];
    return {
      label: `${Meta.label}: ${shown.grade}`,
      title: shown.title,
      headerLead: (
        <span
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] border font-mono text-[24px] font-bold leading-none ${grade.chip} ${grade.tone}`}
        >
          {grade.label}
        </span>
      ),
      badges: (
        <>
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <Icon size={11} />
            {Meta.label}
          </span>
          {shown.confidence !== null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {Math.round(shown.confidence * 100)}% confidence
            </span>
          )}
        </>
      ),
      footer:
        shown.status === 'converted' ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => onGotoBoard?.()}
          >
            <MoveIcon size={15} />
            Go to task
          </Button>
        ) : (
          <Button disabled={pending} onClick={() => onHarden(shown.id)}>
            <BuildIcon size={15} />
            Harden this
          </Button>
        ),
      sections: {
        description: shown.summary,
        descriptionTitle: 'Assessment',
        location: formatLocation(shown.location, { withSymbol: true }),
        rationale: shown.rationale,
        rationaleTitle: 'To raise the grade',
        suggestion: shown.suggestion,
        suggestionTitle: 'Suggested action',
        extra: shown.findings.length > 0 && (
          <DetailSection title="Evidence">
            <ul className="flex flex-col gap-1.5">
              {shown.findings.map((ev, i) => (
                <li
                  key={`${ev.detail}-${i}`}
                  className="text-[12.5px] leading-relaxed text-muted-foreground"
                >
                  {ev.detail}
                  {ev.location !== null && (
                    <code className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                      {ev.location.file}
                      {ev.location.startLine !== null
                        ? `:${ev.location.startLine}`
                        : ''}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          </DetailSection>
        ),
        affectedFiles: shown.affectedFiles,
        tags: shown.tags,
      },
    };
  };

  return (
    <GroundedFindingBody
      open={open}
      item={reading}
      onClose={onClose}
      render={render}
    />
  );
}
