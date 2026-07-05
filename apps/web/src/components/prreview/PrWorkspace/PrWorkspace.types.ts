/** Types for the PR Review workspace panel (the right side of the permanent
 *  two-panel layout). */
import type { PrChangedFile, PrStatus, PrSummary } from '@/lib/bridge';

import type { ReviewLifecycle } from '../prreview-lifecycle';
import type { PrNumberStatusView } from '../PrStatusBlock/PrStatusBlock.hooks';
import type { ReviewSectionProps } from '../ReviewSection';

/** Story/test seam for the changed-file expander: supplies the files (and its
 *  loading/error states) directly, suppressing the on-expand gh fetch. */
export interface ChangedFilesOverride {
  files?: PrChangedFile[];
  loading?: boolean;
  error?: string | null;
}

export interface PrWorkspaceProps {
  /** The selected PR number — set even when `pr` is null (a typed number). */
  prNumber: number;
  /** The selected PR's summary from the open list, or null when the number was
   *  typed manually (closed / old / beyond the list cap). */
  pr: PrSummary | null;
  /** Open the PR on GitHub in the default browser. */
  onOpenExternal: (url: string) => void;
  /** The fully-assembled review-section props (built by the view model). */
  review: ReviewSectionProps;
  /** The PR's derived review lifecycle — the status line (dot + label +
   *  description) at the top of the panel. Absent renders no status line. */
  lifecycle?: ReviewLifecycle | null;
  /** The lifted live-status view (from the view model), passed through to the
   *  status block so it doesn't self-fetch. */
  statusView?: PrNumberStatusView;
  /** Story/test seam passed through to the status block (suppresses its fetch). */
  statusOverride?: PrStatus | null;
  /** Story/test seam for the changed-file expander (suppresses its on-expand
   *  gh fetch). Absent ⇒ the expander fetches lazily on first open. */
  changedFilesOverride?: ChangedFilesOverride;
}
