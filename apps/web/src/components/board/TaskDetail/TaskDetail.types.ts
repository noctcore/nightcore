/** Prop types for the TaskDetail drawer. The grouped action callbacks live in
 *  the board's `TaskActionsContext` (`../actions`) — they reach the drawer's
 *  chrome and leaves via `useTaskActions()`, not props. */
import type {
  GauntletResult,
  PermissionPrompt,
  PrReviewComments,
  PrStatus,
  PrSupport,
  QuestionPrompt,
  Task,
} from '@/lib/bridge';

import type { PrReviewCommentsView } from '../PrReviewComments';
import type { PrStatusView } from '../PrStatusCard';
import type { TaskTranscript } from '../session-stream';

/** Props for the TaskDetail drawer: the task, its live transcript, parked
 *  prompts, gauntlet state, and the grouped action callbacks. */
export interface TaskDetailProps {
  task: Task;
  stream: TaskTranscript | undefined;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  /** Parked permission prompts for this task (interactive approval). */
  prompts?: PermissionPrompt[];
  /** Parked AskUserQuestion prompts for this task (interactive answer). */
  questions?: QuestionPrompt[];
  /** The last readiness-gauntlet result for this task (Verified column), or null. */
  gauntlet?: GauntletResult | null;
  /** True while a gauntlet run is in flight for this task. */
  gauntletRunning?: boolean;
  /** Story/test override for the PR capability probe. When provided (including
   *  `null`), the drawer's lazy `pr_support` fetch is skipped and this value
   *  gates the Create PR button directly; omit it (the app shell does) to let
   *  `usePrSupport` probe lazily per task id. */
  prSupport?: PrSupport | null;
  /** Story/test override for the PR status card. When provided (including
   *  `null`), the card's fetch-on-mount is skipped and this value renders
   *  directly; omit it (the app shell does) to let the card fetch lazily. */
  prStatus?: PrStatus | null;
  /** Story/test override for the Review comments card. When provided (including
   *  `null`), the section's fetch-on-mount is skipped and this payload renders
   *  directly (`null` ⇒ the unavailable note); omit it (the app shell does) to
   *  let the section fetch lazily. */
  prReviewComments?: PrReviewComments | null;
  onClose: () => void;
  /** True while a guarded action (`run`/`approve`/`refine`/`reject`/`commit`/
   *  `merge`) is in flight for this task, so the matching footer button disables
   *  itself between the click and the `nc:task` echo. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
  /** Navigate to the scan item this task was converted from (the provenance
   *  chip's click). A routing concern, so it travels beside `onClose` rather
   *  than in the board-action group; absent ⇒ the chip renders inert. */
  onOpenSourceRef?: (sourceRef: string) => void;
}

/** Props for the memoized `TaskDetailChrome` — the static drawer shell around the
 *  live activity timeline. It takes the already-derived view scalars (never the
 *  per-frame `stream`) so a stream flush that re-renders the outer `TaskDetail`
 *  bails out here; only the context-fed `<ActivityLog>` re-renders. The memo bails
 *  because nothing here turns over on a high-frequency `nc:session` flush: the
 *  scalars (`cost`, the booleans) are passed by value, so the shallow compare
 *  matches until they actually change — `cost` only at a session boundary
 *  (`session-completed` carries the cost; text-delta flushes leave it null), the
 *  booleans only on a `task.status` transition. The callback props are stable
 *  refs — `onClose`/`isActionPending` are memoized. The grouped actions arrive
 *  via `TaskActionsContext` (not a prop) and stay stable ONLY because
 *  `useActionGuard` returns a memoized `action` (an unmemoized one would
 *  re-identify every guarded handler each render and defeat this memo). The one
 *  value that does change every frame — the stream — is deliberately absent; it
 *  reaches `<ActivityLog>` via `TaskStreamContext`. */
export interface TaskDetailChromeProps {
  task: Task;
  /** Aggregate run cost — live stream total, falling back to the persisted total. */
  cost: number | null;
  /** True while the task's build session is streaming (`in_progress`). */
  isRunning: boolean;
  /** A `waiting_approval` parked on a verification verdict (has `review`). */
  reviewParked: boolean;
  /** A `waiting_approval` parked on a plan (`ExitPlanMode`, no verdict yet). */
  planParked: boolean;
  /** Whether the kind picker is editable — only before the task has run. */
  kindEditable: boolean;
  /** Whether the Done-column gauntlet + merge controls apply (a `done` task). */
  isDoneColumn: boolean;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  prompts: PermissionPrompt[];
  questions: QuestionPrompt[];
  gauntlet: GauntletResult | null;
  gauntletRunning: boolean;
  /** The resolved PR capability probe for this task (`null` = unknown/red —
   *  the Create PR button hides). Resolved by the outer drawer's `usePrSupport`
   *  so this memoized chrome stays hook-free. */
  prSupport: PrSupport | null;
  /** The LIFTED PR-status view, resolved by the outer drawer's `usePrStatus`
   *  (fetch once `task.prUrl` exists; the `prStatus` prop overrides for
   *  stories/tests). Shared by the status card (which renders it) and the
   *  footer (Merge disables when the fetched state is MERGED). Memoized by the
   *  hook, so this memo still bails on stream flushes. */
  prStatusView: PrStatusView;
  /** The LIFTED PR review-comments view, resolved by the outer drawer's
   *  `usePrReviewComments` (fetches once `task.prUrl` exists; outside Tauri it
   *  resolves an empty payload → the quiet empty note). Rendered by the read-only
   *  Review comments card below the PR status band. Memoized by the hook, so this
   *  memo still bails on stream flushes. */
  prReviewCommentsView: PrReviewCommentsView;
  onClose: () => void;
  isActionPending?: (action: string, id: string) => boolean;
  onOpenSourceRef?: (sourceRef: string) => void;
}
