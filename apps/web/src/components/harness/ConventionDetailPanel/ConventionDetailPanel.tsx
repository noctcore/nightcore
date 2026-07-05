/** The ConventionDetailPanel sheet for a single convention finding, composed from
 *  the shared DetailPanelShell. */
import {
  Button,
  DetailPanelShell,
  DetailSection,
  Markdown,
  MoveIcon,
  RetryIcon,
  TrashIcon,
  useLastPresent,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionDetailPanelProps } from './ConventionDetailPanel.types';

/** The convention detail sheet: full description, rationale, grounded evidence
 *  files, the rule to codify, tags, and the dismiss/restore lifecycle actions. */
export function ConventionDetailPanel({
  open,
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: ConventionDetailPanelProps) {
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
  const kind = KIND_META[shown.kind];
  const Meta = CATEGORY_META[shown.category];
  const Icon = Meta.icon;

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
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${kind.chip} ${kind.tone}`}
          >
            {kind.label}
          </span>
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
        <Markdown>{shown.description}</Markdown>
      </DetailSection>

      {shown.rationale !== null && (
        <DetailSection title="Why it matters">
          <Markdown>{shown.rationale}</Markdown>
        </DetailSection>
      )}

      {shown.suggestion !== null && (
        <DetailSection title={shown.kind === 'gap' ? 'Change to adopt' : 'Rule to codify'}>
          <Markdown>{shown.suggestion}</Markdown>
        </DetailSection>
      )}

      {shown.evidence.length > 0 && (
        <DetailSection title="Evidence">
          <ul className="flex flex-col gap-1">
            {shown.evidence.map((e) => {
              const label = formatLocation(e, { withSymbol: true }) ?? e.file;
              return (
                <li key={label}>
                  <code className="break-all font-mono text-[11.5px] text-muted-foreground">
                    {label}
                  </code>
                </li>
              );
            })}
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
