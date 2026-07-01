import { Skeleton } from '@/components/ui';
import { PROPOSAL_KIND_META } from '../harness.constants';
import type { HarnessProposalVM } from '../harness.types';
import type { TaskProposalListProps } from './TaskProposalList.types';

/** One proposal card: kind + status badges, title, description, and the convert
 *  signal (bundled-artifact count for `apply-artifacts`, verify command for
 *  `agent-task`) plus any suggested gauntlet check. Read-only in this phase — the
 *  convert / dismiss / go-to-task actions land with the detail panel (phase 3). */
function ProposalCard({ proposal }: { proposal: HarnessProposalVM }) {
  const dimmed = proposal.status === 'dismissed';
  const meta = PROPOSAL_KIND_META[proposal.kind];

  return (
    <div
      title={dimmed ? 'Dismissed' : undefined}
      className="flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] p-3.5 text-left"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
          {meta.label}
        </span>
        {proposal.status === 'converted' && (
          <span className="ml-auto rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
            converted
          </span>
        )}
        {proposal.status === 'dismissed' && (
          <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
            dismissed
          </span>
        )}
      </div>

      <h3
        className={`text-[13.5px] font-semibold leading-snug ${dimmed ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {proposal.title}
      </h3>

      <p
        className={`line-clamp-2 text-[12px] leading-relaxed ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}
      >
        {proposal.description}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {proposal.kind === 'apply-artifacts' && proposal.artifactIds.length > 0 && (
          <span className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono">
            {proposal.artifactIds.length}{' '}
            {proposal.artifactIds.length === 1 ? 'artifact' : 'artifacts'}
          </span>
        )}
        {proposal.verifyCommand !== null && (
          <span className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono">
            verify: {proposal.verifyCommand}
          </span>
        )}
        {proposal.harnessCheck !== null && (
          <span className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono">
            arms: {proposal.harnessCheck.command}
          </span>
        )}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** The proposals panel: the task-shaped recommendations synthesis produced, each the
 *  unit the user converts into a board task. Renders skeletons while the synthesis
 *  pass is still running, and an empty message otherwise. */
export function TaskProposalList({
  proposals,
  loading,
  emptyMessage,
}: TaskProposalListProps) {
  if (proposals.length === 0) {
    if (loading) {
      return (
        <div
          role="status"
          aria-busy="true"
          className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2"
        >
          <SkeletonCard />
          <SkeletonCard />
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2">
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}
