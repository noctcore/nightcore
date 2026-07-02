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
} from '@/components/ui';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

/** Infer a syntax-highlight language from the finding's grounded file extension,
 *  defaulting to `ts`. CodeBlock maps anything it doesn't know to plain text. */
function inferLanguage(finding: ReviewFindingView): string {
  const ext = finding.file.split('.').pop()?.toLowerCase();
  return ext !== undefined && ext.length > 0 ? ext : 'ts';
}

/** The finding detail sheet: the inert body, grounded location, suggested fix, and
 *  the lifecycle actions (convert / dismiss / restore). */
export function FindingDetailPanel({
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: FindingDetailPanelProps) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = LENS_META[finding.lens];
  const Icon = Meta.icon;
  const loc =
    finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
  const lang = inferLanguage(finding);

  return (
    <DetailPanelShell
      label={finding.title}
      onClose={onClose}
      title={finding.title}
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
          {finding.status === 'converted' ? (
            <Button variant="secondary" disabled={pending} onClick={onGotoBoard}>
              <MoveIcon size={15} />
              Go to task
            </Button>
          ) : (
            <Button
              disabled={pending || finding.status === 'dismissed'}
              onClick={() => onConvert(finding.id)}
            >
              <MoveIcon size={15} />
              Convert to task
            </Button>
          )}

          {finding.status === 'dismissed' ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onRestore(finding.id)}
            >
              <RetryIcon size={15} />
              Restore
            </Button>
          ) : (
            finding.status !== 'converted' && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => onDismiss(finding.id)}
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
          {finding.body}
        </p>
      </DetailSection>

      <DetailSection title="Location">
        <DetailLocation>{loc}</DetailLocation>
      </DetailSection>

      {finding.suggestedFix !== null && (
        <DetailSection title="Suggested fix">
          <CodeBlock code={finding.suggestedFix} language={lang} />
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}
