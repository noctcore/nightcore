import type { ReactNode } from 'react';
import {
  Button,
  CloseIcon,
  IconButton,
  Markdown,
  Modal,
  MoveIcon,
  RetryIcon,
  TrashIcon,
} from '@/components/ui';
import {
  CATEGORY_META,
  EFFORT_META,
  SEVERITY_META,
} from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

function locationLabel(finding: InsightFinding): string | null {
  const loc = finding.location;
  if (loc === null) return null;
  if (loc.startLine !== null) {
    const range =
      loc.endLine !== null && loc.endLine !== loc.startLine
        ? `${loc.startLine}-${loc.endLine}`
        : String(loc.startLine);
    return `${loc.file}:${range}${loc.symbol !== null ? ` · ${loc.symbol}` : ''}`;
  }
  return loc.file;
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
  const loc = locationLabel(finding);

  return (
    <Modal
      label={finding.title}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      panelClassName="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
      panelStyle={{ animation: 'nc-sheet-in .28s cubic-bezier(.22,1,.36,1)' }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">
            {finding.title}
          </h2>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        <Section title="What">
          <Markdown>{finding.description}</Markdown>
        </Section>

        {loc !== null && (
          <Section title="Location">
            <code className="break-all rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-[11.5px] text-foreground">
              {loc}
            </code>
          </Section>
        )}

        {finding.rationale !== null && (
          <Section title="Why it matters">
            <Markdown>{finding.rationale}</Markdown>
          </Section>
        )}

        {finding.suggestion !== null && (
          <Section title="Suggested fix">
            <Markdown>{finding.suggestion}</Markdown>
          </Section>
        )}

        {finding.codeBefore !== null && (
          <Section title="Before">
            <pre className="overflow-x-auto rounded-md border border-border bg-white/[0.03] p-3 font-mono text-[11.5px] text-foreground">
              {finding.codeBefore}
            </pre>
          </Section>
        )}
        {finding.codeAfter !== null && (
          <Section title="After">
            <pre className="overflow-x-auto rounded-md border border-success/30 bg-success/[0.06] p-3 font-mono text-[11.5px] text-foreground">
              {finding.codeAfter}
            </pre>
          </Section>
        )}

        {finding.affectedFiles.length > 0 && (
          <Section title="Affected files">
            <ul className="flex flex-col gap-1">
              {finding.affectedFiles.map((f) => (
                <li key={f}>
                  <code className="font-mono text-[11.5px] text-muted-foreground">
                    {f}
                  </code>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {finding.tags.length > 0 && (
          <Section title="Tags">
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
          </Section>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-border px-5 py-4">
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
      </div>
    </Modal>
  );
}
