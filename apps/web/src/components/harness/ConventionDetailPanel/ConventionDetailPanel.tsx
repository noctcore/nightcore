/** The ConventionDetailPanel sheet for a single convention finding. */
import type { ReactNode } from 'react';
import {
  Button,
  CloseIcon,
  IconButton,
  Markdown,
  Modal,
  RetryIcon,
  TrashIcon,
} from '@/components/ui';
import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionFindingVM } from '../harness.types';
import type { ConventionDetailPanelProps } from './ConventionDetailPanel.types';

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

function evidenceLabel(e: ConventionFindingVM['evidence'][number]): string {
  if (e.startLine !== null) {
    const range =
      e.endLine !== null && e.endLine !== e.startLine
        ? `${e.startLine}-${e.endLine}`
        : String(e.startLine);
    return `${e.file}:${range}${e.symbol !== null ? ` · ${e.symbol}` : ''}`;
  }
  return e.file;
}

/** The convention detail sheet: full description, rationale, grounded evidence
 *  files, the rule to codify, tags, and the dismiss/restore lifecycle actions. */
export function ConventionDetailPanel({
  finding,
  pending,
  onClose,
  onDismiss,
  onRestore,
}: ConventionDetailPanelProps) {
  const sev = SEVERITY_META[finding.severity];
  const kind = KIND_META[finding.kind];
  const Meta = CATEGORY_META[finding.category];
  const Icon = Meta.icon;

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

        {finding.rationale !== null && (
          <Section title="Why it matters">
            <Markdown>{finding.rationale}</Markdown>
          </Section>
        )}

        {finding.suggestion !== null && (
          <Section title={finding.kind === 'gap' ? 'Change to adopt' : 'Rule to codify'}>
            <Markdown>{finding.suggestion}</Markdown>
          </Section>
        )}

        {finding.evidence.length > 0 && (
          <Section title="Evidence">
            <ul className="flex flex-col gap-1">
              {finding.evidence.map((e) => (
                <li key={evidenceLabel(e)}>
                  <code className="break-all font-mono text-[11.5px] text-muted-foreground">
                    {evidenceLabel(e)}
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
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onDismiss(finding.id)}
          >
            <TrashIcon size={15} />
            Dismiss
          </Button>
        )}
      </div>
    </Modal>
  );
}
