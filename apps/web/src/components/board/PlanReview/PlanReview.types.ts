/** Props for the plan-approval review panel (T6, #147). */
import type { Task } from '@/lib/bridge';

export interface PlanReviewProps {
  /** The plan-parked (`waiting_approval`) task whose stored `plan` is under review. */
  task: Task;
  /** True while the named plan action (`approve` / `refine` / `reject`) is mid-flight
   *  for this task, so the matching button disables itself until the `nc:task` echo
   *  lands. Defaults to never-pending. */
  pending?: (action: string) => boolean;
}
