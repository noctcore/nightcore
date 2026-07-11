import { TerminalIcon } from '@/components/ui';

import { useTaskCardTerminalChip } from './TaskCardTerminalChip.hooks';
import type { TaskCardTerminalChipProps } from './TaskCardTerminalChip.types';

/** A small "terminal" chip on a task card (cockpit spec PR 4, decision 2), shown only
 *  when a live terminal is linked to the task. Clicking it routes to the Terminal view
 *  and activates the linked tab. Renders nothing when unlinked. */
export function TaskCardTerminalChip({ taskId }: TaskCardTerminalChipProps) {
  const { sessionId, onOpen } = useTaskCardTerminalChip(taskId);
  if (sessionId === null) return null;
  return (
    <button
      type="button"
      aria-label="Open linked terminal"
      title="A terminal is linked to this task — open it"
      onClick={onOpen}
      className="flex items-center gap-1 rounded-md bg-primary/[0.12] px-1.5 py-0.5 font-mono text-[9.5px] text-primary transition-colors hover:bg-primary/20"
    >
      <TerminalIcon size={11} />
      terminal
    </button>
  );
}
