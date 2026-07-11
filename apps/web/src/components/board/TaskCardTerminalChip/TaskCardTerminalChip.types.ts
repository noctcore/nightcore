/** Props for {@link TaskCardTerminalChip} — the linked-terminal chip on a task card. */
export interface TaskCardTerminalChipProps {
  /** The task this card renders; the chip shows only when a live terminal is linked
   *  to it (cockpit spec PR 4, decision 2). */
  taskId: string;
}
