/** Prop types for the PrReviewComments — the read-only review-comments surface
 *  in TaskDetail (PR phase 3). */
import type { Task } from '@/lib/bridge';

import type { PrReviewCommentsView } from './PrReviewComments.hooks';

/** Props for {@link PrReviewComments}. Rendered by TaskDetail when `task.prUrl`
 *  is set, directly below the PrStatusCard band. The single mutation handler is
 *  the AppShell's guarded address-comments action (promise-returning). */
export interface PrReviewCommentsProps {
  /** The task whose PR comments are shown (`status`/`merged` gate the Address run). */
  task: Task;
  /** The LIFTED comments view: TaskDetail owns the `usePrReviewComments` hook so
   *  its state survives stream flushes (memoized) and shares one fetch. */
  view: PrReviewCommentsView;
  /** Dispatch the fix run addressing the comments (guarded; pending key
   *  `addressPrComments`). Absent ⇒ the Address button stays a dead control. */
  onAddressComments?: (id: string) => Promise<void>;
  /** True while a guarded action is in flight for this task, so the Address
   *  button disables between click and settle. Defaults to never-pending. */
  isActionPending?: (key: string, id: string) => boolean;
}
