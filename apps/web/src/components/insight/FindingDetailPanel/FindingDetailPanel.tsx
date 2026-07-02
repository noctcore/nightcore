/** The Insight finding detail sheet, composed from the shared DetailPanelShell. */
import {
  Button,
  CodeBlock,
  DetailLocation,
  DetailPanelShell,
  DetailSection,
  Markdown,
  MoveIcon,
  RetryIcon,
  TrashIcon,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import {
  CATEGORY_META,
  EFFORT_META,
  SEVERITY_META,
} from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

/** Infer a syntax-highlight language from the finding's grounded file extension,
 *  defaulting to `ts`. CodeBlock maps anything it doesn't know to plain text. */
function inferLanguage(finding: InsightFinding): string {
  const file = finding.location?.file;
  const ext = file?.split('.').pop()?.toLowerCase();
  return ext !== undefined && ext.length > 0 ? ext : 'ts';
}

/** The finding detail sheet: full description, rationale, grounded location,
 *  suggested fix, before/after, affected files, and the lifecycle actions. */
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
  const Meta = CATEGORY_META[finding.category];
  const Icon = Meta.icon;
  const loc = formatLocation(finding.location, { withSymbol: true });
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
          <span className="font-mono text-[10px] text-muted-foreground">
            {EFFORT_META[finding.effort].label} effort
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

      {loc !== null && (
        <DetailSection title="Location">
          <DetailLocation>{loc}</DetailLocation>
        </DetailSection>
      )}

      {finding.rationale !== null && (
        <DetailSection title="Why it matters">
          <Markdown>{finding.rationale}</Markdown>
        </DetailSection>
      )}

      {finding.suggestion !== null && (
        <DetailSection title="Suggested fix">
          <Markdown>{finding.suggestion}</Markdown>
        </DetailSection>
      )}

      {finding.codeBefore !== null && (
        <DetailSection title="Before">
          <CodeBlock code={finding.codeBefore} language={lang} />
        </DetailSection>
      )}
      {finding.codeAfter !== null && (
        <DetailSection title="After">
          <CodeBlock
            code={finding.codeAfter}
            language={lang}
            className="border-success/30 bg-success/[0.06]"
          />
        </DetailSection>
      )}

      {finding.affectedFiles.length > 0 && (
        <DetailSection title="Affected files">
          <ul className="flex flex-col gap-1">
            {finding.affectedFiles.map((f) => (
              <li key={f}>
                <code className="font-mono text-[11.5px] text-muted-foreground">
                  {f}
                </code>
              </li>
            ))}
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
