import type { TaskStatus } from '../bridge';
import { STATUS_DOT } from '../status';

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
      aria-hidden
    />
  );
}
