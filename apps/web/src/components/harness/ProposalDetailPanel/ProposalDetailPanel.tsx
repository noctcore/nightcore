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
} from '@/components/ui';

import { PROPOSAL_KIND_META } from '../harness.constants';
import type { ProposalDetailPanelProps } from './ProposalDetailPanel.types';

/** The proposal detail sheet: kind + confidence chrome, description, rationale, the
 *  agent-task prompt, the verify command, any suggested gauntlet check + bundled
 *  artifacts, and the apply / convert / dismiss / restore / go-to-task lifecycle actions. */
export function ProposalDetailPanel({
  proposal,
  pending,
  onClose,
  onConvert,
  onApply,
  onDismiss,
  onRestore,
  onGotoBoard,
}: ProposalDetailPanelProps) {
  const meta = PROPOSAL_KIND_META[proposal.kind];
  // An `apply-artifacts` proposal bundles safe file writes → it can be applied directly
  // (the deterministic half of propose-then-convert); an `agent-task` has no artifacts.
  const canApply =
    proposal.kind === 'apply-artifacts' && proposal.artifactIds.length > 0;
  const applied = proposal.status === 'applied';
  const dismissed = proposal.status === 'dismissed';

  return (
    <DetailPanelShell
      label={proposal.title}
      onClose={onClose}
      title={proposal.title}
      badges={
        <>
          <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
            {meta.label}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{meta.hint}</span>
          {proposal.confidence !== null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {Math.round(proposal.confidence * 100)}% confidence
            </span>
          )}
        </>
      }
      footer={
        <>
          {proposal.status === 'converted' ? (
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
                  onClick={() => onApply(proposal.id)}
                >
                  <PlusIcon size={15} />
                  Apply bundle
                </Button>
              )}
              <Button
                variant={canApply ? 'secondary' : undefined}
                disabled={pending || dismissed}
                onClick={() => onConvert(proposal.id)}
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
              onClick={() => onRestore(proposal.id)}
            >
              <RetryIcon size={15} />
              Restore
            </Button>
          ) : (
            proposal.status !== 'converted' &&
            !applied && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => onDismiss(proposal.id)}
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
        <Markdown>{proposal.description}</Markdown>
      </DetailSection>

      {proposal.rationale !== null && (
        <DetailSection title="Why it matters">
          <Markdown>{proposal.rationale}</Markdown>
        </DetailSection>
      )}

      {proposal.prompt !== null && (
        <DetailSection title="Task for the agent">
          <Markdown>{proposal.prompt}</Markdown>
        </DetailSection>
      )}

      {proposal.verifyCommand !== null && (
        <DetailSection title="Verify with">
          <CodeBlock code={proposal.verifyCommand} language="bash" />
        </DetailSection>
      )}

      {proposal.harnessCheck !== null && (
        <DetailSection title="Suggested Structure-Lock check">
          <p className="text-[12px] text-muted-foreground">
            After this lands, arm{' '}
            <code className="rounded border border-border bg-white/[0.04] px-1 py-0.5 font-mono text-[11.5px] text-foreground">
              {proposal.harnessCheck.command}
            </code>{' '}
            (kind{' '}
            <span className="font-mono text-foreground">{proposal.harnessCheck.kind}</span>)
            so the gauntlet enforces it on every future task.
          </p>
        </DetailSection>
      )}

      {proposal.artifactIds.length > 0 && (
        <DetailSection title={`Bundles ${proposal.artifactIds.length} artifact(s)`}>
          <p className="text-[12px] text-muted-foreground">
            <span className="font-semibold text-foreground">Apply bundle</span> writes all{' '}
            {proposal.artifactIds.length}{' '}
            {proposal.artifactIds.length === 1 ? 'artifact' : 'artifacts'} to disk directly
            (no agent, no cost), through the same hardened path as the Artifacts tab.
          </p>
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}
