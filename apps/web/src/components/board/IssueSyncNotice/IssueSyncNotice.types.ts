import type { Task } from '@/lib/bridge';

/** Props for {@link IssueSyncNotice}. */
export interface IssueSyncNoticeProps {
  /** The task whose `issueSyncError` (the last writeback-degradation reason) the
   *  notice surfaces. Renders nothing when the field is unset (sync healthy/off). */
  task: Task;
}
