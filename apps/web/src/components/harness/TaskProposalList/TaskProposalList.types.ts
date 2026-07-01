import type { HarnessProposalVM } from '../harness.types';

export interface TaskProposalListProps {
  proposals: HarnessProposalVM[];
  /** True while a scan runs and the synthesis pass hasn't emitted yet (skeleton). */
  loading: boolean;
  /** Shown when there are no proposals and nothing is streaming. */
  emptyMessage: string;
  /** Open a proposal in the detail panel (convert / dismiss / go-to-task flow). */
  onOpen: (proposal: HarnessProposalVM) => void;
}
