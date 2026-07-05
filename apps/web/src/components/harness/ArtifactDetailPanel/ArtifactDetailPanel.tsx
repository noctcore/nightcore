import type { ReactNode } from 'react';

import {
  Button,
  CheckIcon,
  CloseIcon,
  CodeBlock,
  IconButton,
  LockIcon,
  Markdown,
  Modal,
  PlusIcon,
  RetryIcon,
  slideIn,
  TrashIcon,
  useLastPresent,
} from '@/components/ui';

import {
  ARTIFACT_KIND_META,
  isEslintArmableKind,
  WRITE_MODE_META,
} from '../harness.constants';
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
  open,
  artifact,
  pending,
  onClose,
  onApply,
  onDismiss,
  onRestore,
  onArm,
}: ArtifactDetailPanelProps) {
  // Retain the selected artifact across the exit animation so the sheet doesn't
  // blank/crash when the parent clears its selection on close. Callbacks stay live.
  const art = useLastPresent(open ? artifact : null) ?? artifact;

  const mode = art !== null ? WRITE_MODE_META[art.writeMode] : undefined;
  const applied = art?.status === 'applied';
  // An applied ESLint-class artifact can be armed as a project gauntlet check so it
  // actually runs (an applied plugin is otherwise inert — never loaded by the repo's
  // own eslint config). Docs/lint-meta artifacts aren't eslint-runnable ⇒ no arm.
  const canArm =
    applied && onArm !== undefined && art !== null && isEslintArmableKind(art.kind);

  return (
    <Modal
      open={open}
      label={art?.title ?? 'Artifact'}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      panelClassName="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
      panelVariants={slideIn}
    >
      {art !== null && (
        <>
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
              {ARTIFACT_KIND_META[art.kind].label}
            </span>
            <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {art.writeMode}
            </span>
            {art.groupTitle !== null && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {art.groupTitle}
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
            {art.title}
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
            {art.appliedPath ?? art.targetPath}
          </code>
          {mode !== undefined && (
            <p className="text-[12px] text-muted-foreground">
              <span className="font-mono text-foreground">{mode.label}</span> — {mode.hint}
            </p>
          )}
        </Section>

        <Section title="What">
          <Markdown>{art.description}</Markdown>
        </Section>

        {art.rationale !== null && (
          <Section title="Why it enforces">
            <Markdown>{art.rationale}</Markdown>
          </Section>
        )}

        {art.sourceFindings.length > 0 && (
          <Section title="Enforces conventions">
            <div className="flex flex-wrap gap-1.5">
              {art.sourceFindings.map((f) => (
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
          <CodeBlock code={art.content} language={art.language ?? undefined} />
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
            disabled={pending || art.status === 'dismissed'}
            onClick={() => onApply(art.id)}
          >
            <PlusIcon size={15} />
            Apply
          </Button>
        )}

        {canArm && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => onArm?.(art.id)}
          >
            <LockIcon size={15} />
            Arm gauntlet check
          </Button>
        )}

        {art.status === 'dismissed' ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onRestore(art.id)}
          >
            <RetryIcon size={15} />
            Restore
          </Button>
        ) : (
          !applied && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onDismiss(art.id)}
            >
              <TrashIcon size={15} />
              Dismiss
            </Button>
          )
        )}
      </div>
        </>
      )}
    </Modal>
  );
}
