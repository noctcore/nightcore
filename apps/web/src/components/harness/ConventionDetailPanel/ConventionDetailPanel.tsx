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
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionDetailPanelProps } from './ConventionDetailPanel.types';

/** The convention detail sheet: full description, rationale, grounded evidence
 *  files, the rule to codify, tags, and the dismiss/restore lifecycle actions. */
export function ConventionDetailPanel({
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: ConventionDetailPanelProps) {
  const sev = SEVERITY_META[finding.severity];
  const kind = KIND_META[finding.kind];
  const Meta = CATEGORY_META[finding.category];
  const Icon = Meta.icon;

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
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${kind.chip} ${kind.tone}`}
          >
            {kind.label}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <Icon size={11} />
            {Meta.label}
          </span>
          {finding.confidence !== null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {Math.round(finding.confidence * 100)}% confidence
            </span>
          )}
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
        <Markdown>{finding.description}</Markdown>
      </DetailSection>

      {finding.rationale !== null && (
        <DetailSection title="Why it matters">
          <Markdown>{finding.rationale}</Markdown>
        </DetailSection>
      )}

      {finding.suggestion !== null && (
        <DetailSection title={finding.kind === 'gap' ? 'Change to adopt' : 'Rule to codify'}>
          <Markdown>{finding.suggestion}</Markdown>
        </DetailSection>
      )}

      {finding.evidence.length > 0 && (
        <DetailSection title="Evidence">
          <ul className="flex flex-col gap-1">
            {finding.evidence.map((e) => {
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

      {finding.tags.length > 0 && (
        <DetailSection title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {finding.tags.map((t) => (
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
