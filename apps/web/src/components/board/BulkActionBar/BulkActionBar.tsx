import {
  Button,
  CloseIcon,
  LockIcon,
  Menu,
  MoveIcon,
  PlayIcon,
  TrashIcon,
} from '@/components/ui';
import { pluralize } from '@/lib/formatters';

import { useBulkActionBar } from './BulkActionBar.hooks';
import { BulkVerbButton } from './BulkActionBar.parts';
import type { BulkActionBarProps } from './BulkActionBar.types';

/** The multi-select verb bar (#402): pick N cards, act once.
 *
 *  Appears between the worktree switcher and the columns the moment anything is selected,
 *  and disappears when the selection empties — so it costs nothing on an untouched board.
 *
 *  The verbs that matter at 20+ tasks: **Chain** (make the selection sequential — the
 *  two-click replacement for hand-minting a dependency chain in the task JSON), its exact
 *  inverse **Unchain**, **Run** (gated on real free slots rather than firing N rejections),
 *  **Move to <column>**, and **Delete** behind ONE confirmation instead of N dialogs.
 *
 *  Every verb runs in the coordinator's launch order, and a disabled verb always states
 *  its reason rather than vanishing. */
export function BulkActionBar(props: BulkActionBarProps) {
  const v = useBulkActionBar(props);
  if (v.count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Bulk task actions"
      className="flex flex-wrap items-center gap-2 border-b border-primary/30 bg-primary/[0.06] px-[22px] py-2.5"
    >
      <span className="font-mono text-2xs-plus font-semibold text-primary">
        {pluralize(v.count, 'task')} selected
      </span>

      <span aria-hidden className="mx-1 h-4 w-px bg-white/10" />

      <BulkVerbButton verb={v.runAll} label="Run" icon={<PlayIcon size={13} />} />
      <BulkVerbButton
        verb={v.chain}
        label="Chain"
        variant="secondary"
        icon={<LockIcon size={13} />}
        title="Make the selection sequential — each task waits on the one before it"
      />
      <BulkVerbButton
        verb={v.unchain}
        label="Unchain"
        variant="secondary"
        icon={<LockIcon size={13} />}
        title="Drop the dependency edges between the selected tasks"
      />

      <Menu
        label="Move selected tasks"
        align="left"
        items={v.moveItems}
        trigger={
          <Button variant="secondary">
            <MoveIcon size={13} />
            Move to…
          </Button>
        }
      />

      <BulkVerbButton
        verb={v.remove}
        label="Delete"
        variant="danger"
        icon={<TrashIcon size={13} />}
      />

      <Button variant="ghost" onClick={v.clear} className="ml-auto">
        <CloseIcon size={13} />
        Clear selection
      </Button>
    </div>
  );
}
