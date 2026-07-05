/** The ProposalDetailPanel sheet for a single task-shaped harness proposal, composed
 *  from the shared DetailPanelShell. The convert action mints a Build task (carrying the
 *  proposal's verifyCommand onto the task's gauntlet check). */
import {
  Button,
  CheckIcon,
  CodeBlock,
  DetailPanelShell,
  DetailSection,
  Markdown,
  MoveIcon,
  PlusIcon,
  RetryIcon,
  TrashIcon,
  useLastPresent,
} from '@/components/ui';

import { PROPOSAL_KIND_META } from '../harness.constants';
import type { ProposalDetailPanelProps } from './ProposalDetailPanel.types';

/** The proposal detail sheet: kind + confidence chrome, description, rationale, the
 *  agent-task prompt, the verify command, any suggested gauntlet check + bundled
 *  artifacts, and the apply / convert / dismiss / restore / go-to-task lifecycle actions. */
export function ProposalDetailPanel({
  open,
  proposal,
  pending,
  onClose,
  onConvert,
  onApply,
  onDismiss,
  onRestore,
  onGotoBoard,
}: ProposalDetailPanelProps) {
  // Retain the last proposal so the sheet keeps its content while it animates out.
  const shown = useLastPresent(proposal);
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

  const meta = PROPOSAL_KIND_META[shown.kind];
  // An `apply-artifacts` proposal bundles safe file writes → it can be applied directly
  // (the deterministic half of propose-then-convert); an `agent-task` has no artifacts.
  const canApply =
    shown.kind === 'apply-artifacts' && shown.artifactIds.length > 0;
  const applied = shown.status === 'applied';
  const dismissed = shown.status === 'dismissed';

  return (
    <DetailPanelShell
      open={open}
      label={shown.title}
      onClose={onClose}
      title={shown.title}
      badges={
        <>
          <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
            {meta.label}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{meta.hint}</span>
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
          ) : applied ? (
            <Button variant="secondary" disabled>
              <CheckIcon size={15} />
              Applied
            </Button>
          ) : (
            <>
              {canApply && (
                <Button
                  disabled={pending || dismissed}
                  onClick={() => onApply(shown.id)}
                >
                  <PlusIcon size={15} />
                  Apply bundle
                </Button>
              )}
              <Button
                variant={canApply ? 'secondary' : undefined}
                disabled={pending || dismissed}
                onClick={() => onConvert(shown.id)}
              >
                <MoveIcon size={15} />
                Convert to task
              </Button>
            </>
          )}

          {dismissed ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => onRestore(shown.id)}
            >
              <RetryIcon size={15} />
              Restore
            </Button>
          ) : (
            shown.status !== 'converted' &&
            !applied && (
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

      {shown.prompt !== null && (
        <DetailSection title="Task for the agent">
          <Markdown>{shown.prompt}</Markdown>
        </DetailSection>
      )}

      {shown.verifyCommand !== null && (
        <DetailSection title="Verify with">
          <CodeBlock code={shown.verifyCommand} language="bash" />
        </DetailSection>
      )}

      {shown.harnessCheck !== null && (
        <DetailSection title="Suggested Structure-Lock check">
          <p className="text-[12px] text-muted-foreground">
            After this lands, arm{' '}
            <code className="rounded border border-border bg-white/[0.04] px-1 py-0.5 font-mono text-[11.5px] text-foreground">
              {shown.harnessCheck.command}
            </code>{' '}
            (kind{' '}
            <span className="font-mono text-foreground">{shown.harnessCheck.kind}</span>)
            so the gauntlet enforces it on every future task.
          </p>
        </DetailSection>
      )}

      {shown.artifactIds.length > 0 && (
        <DetailSection title={`Bundles ${shown.artifactIds.length} artifact(s)`}>
          <p className="text-[12px] text-muted-foreground">
            <span className="font-semibold text-foreground">Apply bundle</span> writes all{' '}
            {shown.artifactIds.length}{' '}
            {shown.artifactIds.length === 1 ? 'artifact' : 'artifacts'} to disk directly
            (no agent, no cost), through the same hardened path as the Artifacts tab.
          </p>
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}
