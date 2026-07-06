/** Prop types for the PrStatusCard — the live PR-status surface in TaskDetail.
 *  The three mutation handlers + the open-in-browser chip come from
 *  `TaskActionsContext` (`onPushPrUpdates` / `onFinalizePr` / `onPullBaseFf` /
 *  `onOpenPr`), not props; an absent handler hides its button. */
import type { PrStatus, Task } from '@/lib/bridge';

import type { PrStatusView } from './PrStatusCard.hooks';

/** Props for {@link PrStatusCard}. Rendered by TaskDetail when `task.prUrl` is
 *  set. */
export interface PrStatusCardProps {
  /** The task whose PR is tracked (`prUrl`/`prNumber`/`merged`/`branch` gate
   *  the card's affordances). */
  task: Task;
  /** The LIFTED status view (the app path): TaskDetail owns the `usePrStatus`
   *  hook so its footer can read the fetched state (Merge disables on a
   *  remotely-merged PR), and passes the view down here to render. When
   *  provided, the card's own fetch hook stays inert. Stories/tests omit it
   *  and use `statusOverride` / the self-fetch instead. */
  view?: PrStatusView;
  /** True while a guarded action is in flight for this task, so the matching
   *  button disables between click and settle. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
  /** Story/test seam: when provided (including `null`) the fetch-on-mount is
   *  skipped and this value renders directly — `null` shows the unavailable
   *  note. Omit it (the app does) to let the card fetch via `prStatus`. */
  statusOverride?: PrStatus | null;
}
