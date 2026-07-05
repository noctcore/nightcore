/** The Scorecard reading detail sheet, composed from the shared DetailPanelShell. */
import {
  BuildIcon,
  Button,
  DetailLocation,
  DetailPanelShell,
  DetailSection,
  Markdown,
  MoveIcon,
  useLastPresent,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { DIMENSION_META, GRADE_META } from '../scorecard.constants';
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
  // Retain the last reading so the sheet keeps its content while it animates out.
  const shown = useLastPresent(reading);
  if (shown === null) {
    return (
      <DetailPanelShell
        open={false}
        label=""
        onClose={onClose}
        title=""
        badges={null}
        footer={null}
      >
        {null}
      </DetailPanelShell>
    );
  }

  const Meta = DIMENSION_META[shown.dimension];
  const Icon = Meta.icon;
  const grade = GRADE_META[shown.grade];
  const loc = formatLocation(shown.location, { withSymbol: true });

  return (
    <DetailPanelShell
      open={open}
      label={`${Meta.label}: ${shown.grade}`}
      onClose={onClose}
      title={shown.title}
      headerLead={
        <span
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] border font-mono text-[24px] font-bold leading-none ${grade.chip} ${grade.tone}`}
        >
          {grade.label}
        </span>
      }
      badges={
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
      }
      footer={
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
        )
      }
    >
      <DetailSection title="Assessment">
        <Markdown>{shown.summary}</Markdown>
      </DetailSection>

      {loc !== null && (
        <DetailSection title="Location">
          <DetailLocation>{loc}</DetailLocation>
        </DetailSection>
      )}

      {shown.rationale !== null && (
        <DetailSection title="To raise the grade">
          <Markdown>{shown.rationale}</Markdown>
        </DetailSection>
      )}

      {shown.suggestion !== null && (
        <DetailSection title="Suggested action">
          <Markdown>{shown.suggestion}</Markdown>
        </DetailSection>
      )}

      {shown.findings.length > 0 && (
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
      )}

      {shown.affectedFiles.length > 0 && (
        <DetailSection title="Affected files">
          <ul className="flex flex-col gap-1">
            {shown.affectedFiles.map((f) => (
              <li key={f}>
                <code className="font-mono text-[11.5px] text-muted-foreground">
                  {f}
                </code>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {shown.tags.length > 0 && (
        <DetailSection title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {shown.tags.map((t) => (
              <span
                key={t}
                className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}
