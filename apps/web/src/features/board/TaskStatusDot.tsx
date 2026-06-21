import type { TaskStatus } from '../../bridge';
import { StatusDot } from '../../shared/ui';
import { isActive, STATUS_DOT_COLOR } from './status';

/** Board-specific binding of the shared StatusDot to the task status palette. */
export function TaskStatusDot({ status, glow }: { status: TaskStatus; glow?: boolean }) {
  return (
    <StatusDot
      colorClass={STATUS_DOT_COLOR[status]}
      pulse={isActive(status)}
      glow={glow}
    />
  );
}
