import type { ReactNode } from 'react';
import {
  Button,
  CheckIcon,
  CloseIcon,
  CodeBlock,
  IconButton,
  Markdown,
  Modal,
  PlusIcon,
  RetryIcon,
  TrashIcon,
} from '@/components/ui';
import { ARTIFACT_KIND_META, WRITE_MODE_META } from '../harness.constants';
import type { ArtifactDetailPanelProps } from './ArtifactDetailPanel.types';

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

/** The artifact detail sheet: kind/write-mode/target chrome, description and
 *  rationale, the source conventions it enforces, the full file content preview,
 *  and the Apply / Dismiss / Restore lifecycle actions. Apply opens the confirm
 *  dialog upstream (this only signals intent). */
export function ArtifactDetailPanel({
  artifact,
  pending,
  onClose,
  onApply,
  onDismiss,
  onRestore,
}: ArtifactDetailPanelProps) {
  const mode = WRITE_MODE_META[artifact.writeMode];
  const applied = artifact.status === 'applied';

  return (
    <Modal
      label={artifact.title}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      panelClassName="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
      panelStyle={{ animation: 'nc-sheet-in .28s cubic-bezier(.22,1,.36,1)' }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
              {ARTIFACT_KIND_META[artifact.kind].label}
            </span>
            <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {artifact.writeMode}
            </span>
            {artifact.groupTitle !== null && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {artifact.groupTitle}
              </span>
            )}
            {applied && (
              <span className="inline-flex items-center gap-1 rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
                <CheckIcon size={10} />
                applied
              </span>
            )}
          </div>
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">
            {artifact.title}
          </h2>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        <Section title="Target">
          <code className="break-all rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-[11.5px] text-foreground">
            {artifact.appliedPath ?? artifact.targetPath}
          </code>
          {mode !== undefined && (
            <p className="text-[12px] text-muted-foreground">
              <span className="font-mono text-foreground">{mode.label}</span> — {mode.hint}
            </p>
          )}
        </Section>

        <Section title="What">
          <Markdown>{artifact.description}</Markdown>
        </Section>

        {artifact.rationale !== null && (
          <Section title="Why it enforces">
            <Markdown>{artifact.rationale}</Markdown>
          </Section>
        )}

        {artifact.sourceFindings.length > 0 && (
          <Section title="Enforces conventions">
            <div className="flex flex-wrap gap-1.5">
              {artifact.sourceFindings.map((f) => (
                <span
                  key={f}
                  className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {f}
                </span>
              ))}
            </div>
          </Section>
        )}

        <Section title="Content">
          <CodeBlock code={artifact.content} language={artifact.language ?? undefined} />
        </Section>
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-border px-5 py-4">
        {applied ? (
          <Button variant="secondary" disabled>
            <CheckIcon size={15} />
            Applied
          </Button>
        ) : (
          <Button
            disabled={pending || artifact.status === 'dismissed'}
            onClick={() => onApply(artifact.id)}
          >
            <PlusIcon size={15} />
            Apply
          </Button>
        )}

        {artifact.status === 'dismissed' ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onRestore(artifact.id)}
          >
            <RetryIcon size={15} />
            Restore
          </Button>
        ) : (
          !applied && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onDismiss(artifact.id)}
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
