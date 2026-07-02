import { StatusDot } from '@/components/ui';

import { isActive, STATUS_DOT_COLOR } from '../status';
import type { TaskStatusDotProps } from './TaskStatusDot.types';

/** Board-specific binding of the shared StatusDot to the task status palette. */
export function TaskStatusDot({ status, glow }: TaskStatusDotProps) {
  return (
    <StatusDot
      colorClass={STATUS_DOT_COLOR[status]}
      pulse={isActive(status)}
      glow={glow}
    />
  );
}
