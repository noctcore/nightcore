/** Prop types for the PrStatusCard — the live PR-status surface in TaskDetail. */
import type { PrStatus, Task } from '@/lib/bridge';

/** Props for {@link PrStatusCard}. Rendered by TaskDetail when `task.prUrl` is
 *  set. The three mutation handlers are the AppShell's guarded PR-lifecycle
 *  actions (promise-returning so the card can refetch after a push); each is
 *  optional — an absent handler hides its button. */
export interface PrStatusCardProps {
  /** The task whose PR is tracked (`prUrl`/`prNumber`/`merged`/`branch` gate
   *  the card's affordances). */
  task: Task;
  /** Open the PR page in the system browser (the `#<n> ↗` chip). */
  onOpenPr?: (url: string) => void;
  /** Re-push the task branch (guarded; pending key `pushPrUpdates`). The card
   *  refetches the status when this resolves. */
  onPushUpdates?: (id: string) => Promise<void>;
  /** Finalize a remote-merged PR (guarded; pending key `finalizePr`). The
   *  `nc:task` echo flips `task.merged` — no local state juggling. */
  onFinalize?: (id: string) => Promise<void>;
  /** Fast-forward the base branch on the project root (guarded; pending key
   *  `pullBaseFf`). */
  onPullBase?: (id: string) => Promise<void>;
  /** True while a guarded action is in flight for this task, so the matching
   *  button disables between click and settle. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
  /** Story/test seam: when provided (including `null`) the fetch-on-mount is
   *  skipped and this value renders directly — `null` shows the unavailable
   *  note. Omit it (the app does) to let the card fetch via `prStatus`. */
  statusOverride?: PrStatus | null;
}
