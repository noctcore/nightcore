import type { SessionGroup } from '../session-stream';

/** Props for {@link ActivityLog}. */
export interface ActivityLogProps {
  /** Every session in the task's transcript, in order — one collapsible block
   *  each so the in-progress build run stays visible alongside a later
   *  verification run. */
  sessions: SessionGroup[];
  /** True while a run is in flight for this task (drives the live cursor + the
   *  "Live activity" heading and the most-recent session's live affordances). */
  isRunning: boolean;
}
