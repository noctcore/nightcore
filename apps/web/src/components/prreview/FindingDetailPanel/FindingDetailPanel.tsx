/** The PR Review finding detail sheet, composed from the shared DetailPanelShell.
 *  The finding body came from a review model, so it is rendered as INERT text
 *  (`whitespace-pre-wrap`) — never through Markdown / dangerouslySetInnerHTML. The
 *  suggested fix is our own suggested code, shown in a read-only CodeBlock. */
import {
  Button,
  CodeBlock,
  DetailLocation,
  DetailPanelShell,
  DetailSection,
  MoveIcon,
  RetryIcon,
  TrashIcon,
  useLastPresent,
} from '@/components/ui';
import type { ReviewLens } from '@/lib/bridge';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

/** Infer a syntax-highlight language from the finding's grounded file extension,
 *  defaulting to `ts`. CodeBlock maps anything it doesn't know to plain text. */
function inferLanguage(finding: ReviewFindingView): string {
  const ext = finding.file.split('.').pop()?.toLowerCase();
  return ext !== undefined && ext.length > 0 ? ext : 'ts';
}

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
  // Retain the last finding so the sheet keeps its content while it animates out.
  const shown = useLastPresent(finding);
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

  const sev = SEVERITY_META[shown.severity];
  const Meta = LENS_META[shown.lens];
  const Icon = Meta.icon;
  const loc =
    shown.line !== null ? `${shown.file}:${shown.line}` : shown.file;
  const lang = inferLanguage(shown);

  return (
    <DetailPanelShell
      open={open}
      label={shown.title}
      onClose={onClose}
      title={shown.title}
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
        </>
      }
      footer={
        <>
          {shown.status === 'converted' ? (
            <Button variant="secondary" disabled={pending} onClick={onGotoBoard}>
              <MoveIcon size={15} />
              Go to task
            </Button>
          ) : (
            <Button
              disabled={pending || shown.status === 'dismissed'}
              onClick={() => onConvert(shown.id)}
            >
              <MoveIcon size={15} />
              Convert to task
            </Button>
          )}

          {shown.status === 'dismissed' ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onRestore(shown.id)}
            >
              <RetryIcon size={15} />
              Restore
            </Button>
          ) : (
            shown.status !== 'converted' && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => onDismiss(shown.id)}
              >
                <TrashIcon size={15} />
                Dismiss
              </Button>
            )
          )}
        </>
      }
    >
      <DetailSection title="What">
        {/* Model-authored body — rendered as inert text, never as HTML/Markdown. */}
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {shown.body}
        </p>
      </DetailSection>

      {/* Corroboration: the fuller counterpart to the card's "also:" chip —
          which OTHER lenses independently surfaced this same issue. */}
      {shown.corroboratedBy.length > 0 && (
        <DetailSection title="Corroboration">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Also independently surfaced by the{' '}
            {formatLensList(shown.corroboratedBy)}{' '}
            {shown.corroboratedBy.length === 1 ? 'lens' : 'lenses'}.
          </p>
        </DetailSection>
      )}

      <DetailSection title="Location">
        <DetailLocation>{loc}</DetailLocation>
      </DetailSection>

      {shown.suggestedFix !== null && (
        <DetailSection title="Suggested fix">
          <CodeBlock code={shown.suggestedFix} language={lang} />
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}
