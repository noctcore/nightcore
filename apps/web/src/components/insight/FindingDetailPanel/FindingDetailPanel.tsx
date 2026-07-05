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
  useLastPresent,
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
  const Meta = CATEGORY_META[shown.category];
  const Icon = Meta.icon;
  const loc = formatLocation(shown.location, { withSymbol: true });
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
          <span className="font-mono text-[10px] text-muted-foreground">
            {EFFORT_META[shown.effort].label} effort
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

      {loc !== null && (
        <DetailSection title="Location">
          <DetailLocation>{loc}</DetailLocation>
        </DetailSection>
      )}

      {shown.rationale !== null && (
        <DetailSection title="Why it matters">
          <Markdown>{shown.rationale}</Markdown>
        </DetailSection>
      )}

      {shown.suggestion !== null && (
        <DetailSection title="Suggested fix">
          <Markdown>{shown.suggestion}</Markdown>
        </DetailSection>
      )}

      {shown.codeBefore !== null && (
        <DetailSection title="Before">
          <CodeBlock code={shown.codeBefore} language={lang} />
        </DetailSection>
      )}
      {shown.codeAfter !== null && (
        <DetailSection title="After">
          <CodeBlock
            code={shown.codeAfter}
            language={lang}
            className="border-success/30 bg-success/[0.06]"
          />
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
