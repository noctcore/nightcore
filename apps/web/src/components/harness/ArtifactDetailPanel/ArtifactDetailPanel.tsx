/** The artifact detail sheet, composed from the shared GroundedFindingBody
 *  (wide, for the full file-content preview): kind/write-mode/target chrome,
 *  description and rationale, the source conventions it enforces, the content
 *  preview, and the Apply / Dismiss / Restore lifecycle actions. Apply opens
 *  the confirm dialog upstream (this only signals intent). */
import {
  Button,
  CheckIcon,
  CodeBlock,
  DetailSection,
  GroundedFindingBody,
  type GroundedFindingView,
  LockIcon,
  PlusIcon,
  RetryIcon,
  TrashIcon,
} from '@/components/ui';

import {
  ARTIFACT_KIND_META,
  isEslintArmableKind,
  WRITE_MODE_META,
} from '../harness.constants';
import type { ProposedArtifactVM } from '../harness.types';
import type { ArtifactDetailPanelProps } from './ArtifactDetailPanel.types';

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
  const render = (art: ProposedArtifactVM): GroundedFindingView => {
    const mode = WRITE_MODE_META[art.writeMode];
    const applied = art.status === 'applied';
    // An applied ESLint-class artifact can be armed as a project gauntlet check so it
    // actually runs (an applied plugin is otherwise inert — never loaded by the repo's
    // own eslint config). Docs/lint-meta artifacts aren't eslint-runnable ⇒ no arm.
    const canArm = applied && onArm !== undefined && isEslintArmableKind(art.kind);
    return {
      title: art.title,
      badges: (
        <>
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
        </>
      ),
      footer: (
        <>
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
        </>
      ),
      sections: {
        lead: (
          <DetailSection title="Target">
            <code className="break-all rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-[11.5px] text-foreground">
              {art.appliedPath ?? art.targetPath}
            </code>
            {mode !== undefined && (
              <p className="text-[12px] text-muted-foreground">
                <span className="font-mono text-foreground">{mode.label}</span> —{' '}
                {mode.hint}
              </p>
            )}
          </DetailSection>
        ),
        description: art.description,
        rationale: art.rationale,
        rationaleTitle: 'Why it enforces',
        extra: (
          <>
            {art.sourceFindings.length > 0 && (
              <DetailSection title="Enforces conventions">
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
              </DetailSection>
            )}

            <DetailSection title="Content">
              <CodeBlock code={art.content} language={art.language ?? undefined} />
            </DetailSection>
          </>
        ),
      },
    };
  };

  return (
    <GroundedFindingBody
      open={open}
      item={artifact}
      onClose={onClose}
      wide
      render={render}
    />
  );
}
