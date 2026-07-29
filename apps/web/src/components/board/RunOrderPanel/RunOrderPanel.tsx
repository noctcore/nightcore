import { AgentsIcon, Badge, CloseIcon, IconButton, Modal, slideIn } from '@/components/ui';

import { useRunOrderPanel } from './RunOrderPanel.hooks';
import {
  NeverEligibleGroup,
  RunOrderRowItem,
  StartsNowDivider,
} from './RunOrderPanel.parts';
import type { RunOrderPanelProps } from './RunOrderPanel.types';

/** The run-order sheet (#402): the board's execution order, spelled out.
 *
 *  The columns sort newest-updated-first, which is the right reading order and the WRONG
 *  execution order — the auto-loop launches in dependency order, oldest first, `freeSlots`
 *  at a time. On any board with a dependency chain the two diverge silently. This sheet is
 *  the authoritative answer: position 1..N, a "starts now" cut line at the end of wave 0,
 *  the blockers named per row, and a separate group for launchable tasks that can never
 *  become eligible at all.
 *
 *  Read-only. The order comes from the Rust `run_order` command (whose wave 0 is pinned to
 *  the auto-loop tick's own slice by a parity test) — this sheet never re-derives it. */
export function RunOrderPanel({ open, tasks, onClose, onSelectTask }: RunOrderPanelProps) {
  const v = useRunOrderPanel({ tasks });
  // The cut line sits after the last wave-0 row: everything above starts on the next pass.
  const startsNowCount = v.rows.filter((row) => row.startsNow).length;

  return (
    <Modal
      open={open}
      label="Run order"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      variant="sheet"
      panelClassName="max-w-md"
      panelVariants={slideIn}
    >
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <AgentsIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">Run order</h2>
            <Badge>read-only</Badge>
          </div>
          <p className="truncate font-mono text-2xs text-muted-foreground">
            {v.freeSlots} of {v.maxConcurrency} slots free · {v.preview.summary}
          </p>
        </div>
        <IconButton label="Close run order" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        <p className="text-2xs-plus leading-snug text-muted-foreground">
          The order Auto Mode picks tasks up in — dependency order, oldest first. The
          columns sort by recent activity instead, so this is the list that decides what
          actually runs.
        </p>

        {v.rows.length === 0 ? (
          <p className="rounded-nc border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground">
            Nothing is queued to run.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {v.rows.map((row, index) => (
              <li key={row.id} className="flex flex-col gap-1.5">
                <RunOrderRowItem row={row} onSelectTask={onSelectTask} />
                {index + 1 === startsNowCount && index + 1 < v.rows.length && (
                  <StartsNowDivider />
                )}
              </li>
            ))}
          </ol>
        )}

        <NeverEligibleGroup rows={v.unreachable} />
      </div>
    </Modal>
  );
}
