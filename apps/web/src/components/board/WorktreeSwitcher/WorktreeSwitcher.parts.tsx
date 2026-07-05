/** Presentational sub-parts for the WorktreeSwitcher: the shared status chips, the
 *  per-tab button and its actions menu, and the overflow-collapse searchable
 *  select (trigger + listbox rows). No state lives here — the collapsed select's
 *  open/query/highlight state comes from `useWorktreeCollapsedSelect`. */
import {
  AlertIcon,
  BoardIcon,
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  DotsIcon,
  IconButton,
  LayersIcon,
  Menu,
  SearchIcon,
  Spinner,
  TrashIcon,
} from '@/components/ui';
import { rovingKeydown } from '@/lib/roving-keydown';

import { useWorktreeCollapsedSelect } from './WorktreeSwitcher.hooks';
import type {
  ActiveWorktree,
  WorktreeSelectRow,
  WorktreeTab,
} from './WorktreeSwitcher.types';

/** The shared status-chip cluster shown on both a worktree tab and a collapsed
 *  select row: the task count, a pulsing running count, the dirty `●N` marker, and
 *  the ahead `↑N` / behind `↓N` tracking counts. Kept in one place so a tab and its
 *  collapsed row can never drift — the collapse loses no information. */
export function WorktreeChips({ tab }: { tab: WorktreeTab }) {
  return (
    <>
      {tab.taskCount > 0 && (
        <span className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded bg-white/[0.07] px-1 text-[10px] tabular-nums text-muted-foreground">
          {tab.taskCount}
        </span>
      )}

      {tab.runningCount > 0 && (
        <span
          className="flex items-center gap-1 text-[10px] font-semibold text-warning"
          aria-label={`${tab.runningCount} running`}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
          {tab.runningCount}
        </span>
      )}

      {tab.dirty && (
        <span
          className="text-[10px] font-semibold tabular-nums text-warning"
          aria-label={
            tab.changedFiles > 0 ? `${tab.changedFiles} uncommitted files` : 'Uncommitted changes'
          }
        >
          ●{tab.changedFiles > 0 ? tab.changedFiles : ''}
        </span>
      )}

      {tab.aheadOfBase > 0 && (
        <span
          className="text-[10px] font-semibold tabular-nums text-success"
          aria-label={`${tab.aheadOfBase} commits ahead of base`}
        >
          ↑{tab.aheadOfBase}
        </span>
      )}

      {tab.behindOfBase > 0 && (
        <span
          className="text-[10px] font-semibold tabular-nums text-warning"
          aria-label={`${tab.behindOfBase} commits behind base`}
        >
          ↓{tab.behindOfBase}
        </span>
      )}
    </>
  );
}

/** The hover/tooltip title shared by a worktree tab and its collapsed row. */
function worktreeTitle(tab: WorktreeTab): string {
  if (tab.branch === null) return 'Tasks running on the project directory';
  return `Worktree ${tab.branch}${
    tab.dirty
      ? ` · ${tab.changedFiles > 0 ? `${tab.changedFiles} changed` : 'uncommitted changes'}`
      : ''
  }${tab.aheadOfBase > 0 ? ` · ↑${tab.aheadOfBase}` : ''}${
    tab.behindOfBase > 0 ? ` · ↓${tab.behindOfBase}` : ''
  }`;
}

/** Props for a single worktree tab button. */
interface WorktreeTabButtonProps {
  tab: WorktreeTab;
  selected: boolean;
  onSelect: () => void;
}

/** A single switcher tab: the Main or branch
 *  label with a task-count chip and a monitor cluster — a pulsing running dot, a
 *  dirty marker, and an ahead-of-base count. */
export function WorktreeTabButton({ tab, selected, onSelect }: WorktreeTabButtonProps) {
  const isMain = tab.branch === null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onKeyDown={rovingKeydown}
      onClick={onSelect}
      title={worktreeTitle(tab)}
      className={`flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 font-mono text-[12px] transition-colors ${
        selected
          ? 'border-primary/60 bg-primary/[0.12] text-foreground'
          : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20 hover:text-foreground'
      }`}
    >
      <span className={selected ? 'text-primary' : 'text-muted-foreground'}>
        {isMain ? <BoardIcon size={12} /> : <BranchIcon size={12} />}
      </span>
      <span className="max-w-[180px] truncate">{tab.label}</span>

      <WorktreeChips tab={tab} />
    </button>
  );
}

/** Props for a worktree tab paired with its actions menu. */
interface WorktreeTabWithActionsProps {
  tab: WorktreeTab;
  selected: boolean;
  onSelect: () => void;
  /** Discard this worktree's checkout + branch; omit to hide the actions menu. */
  onRemove?: (tab: WorktreeTab) => void;
}

/** A worktree tab paired with its actions menu. The kebab is a SIBLING of the
 *  `role="tab"` button (never nested — that would bury an interactive inside the
 *  tab), and only renders when a remove handler is supplied. Its one item,
 *  "Remove worktree", discards the checkout + branch (the switcher's first action
 *  affordance). */
export function WorktreeTabWithActions({
  tab,
  selected,
  onSelect,
  onRemove,
}: WorktreeTabWithActionsProps) {
  return (
    <div className="flex items-center">
      <WorktreeTabButton tab={tab} selected={selected} onSelect={onSelect} />
      {onRemove !== undefined && (
        <Menu
          label={`Actions for ${tab.label}`}
          align="left"
          trigger={
            <IconButton label={`Worktree actions for ${tab.label}`} className="ml-0.5">
              <DotsIcon size={14} />
            </IconButton>
          }
          items={[
            {
              label: 'Remove worktree',
              icon: <TrashIcon size={14} />,
              destructive: true,
              onClick: () => onRemove(tab),
            },
          ]}
        />
      )}
    </div>
  );
}

/** Props for one collapsed-select row. */
interface WorktreeSelectRowButtonProps {
  row: WorktreeSelectRow;
  highlighted: boolean;
  selected: boolean;
  onHighlight: (index: number) => void;
  onSelect: (branch: string | null) => void;
}

/** One selectable worktree inside the collapsed listbox: a check for the active
 *  worktree, the branch label, and the same status chips as its tab (pushed right).
 *  `mousedown` is suppressed so picking with the pointer doesn't blur the search
 *  input before the click lands. The chips sit at the row's end, leaving room ahead
 *  of them for a future per-row kebab / drag-onto-worktree target (worktree-parity +
 *  seq 916) to hang off the row without a rewrite. */
export function WorktreeSelectRowButton({
  row,
  highlighted,
  selected,
  onHighlight,
  onSelect,
}: WorktreeSelectRowButtonProps) {
  const { tab } = row;
  return (
    <button
      id={row.id}
      type="button"
      role="option"
      aria-selected={selected}
      onMouseEnter={() => onHighlight(row.index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(tab.branch)}
      title={worktreeTitle(tab)}
      className={`flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left font-mono text-[12px] transition-colors ${
        highlighted ? 'bg-primary/[0.12]' : 'hover:bg-white/[0.04]'
      }`}
    >
      <span className="flex w-3.5 shrink-0 justify-center text-primary" aria-hidden>
        {selected && <CheckIcon size={13} />}
      </span>
      <BranchIcon size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{tab.label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <WorktreeChips tab={tab} />
      </span>
    </button>
  );
}

/** Props for the collapsed searchable select. */
interface WorktreeCollapsedSelectProps {
  /** The worktree tabs folded into the select (never Main). */
  tabs: WorktreeTab[];
  /** The active selection (a collapsed branch marks itself; Main → neutral). */
  active: ActiveWorktree;
  /** Select a worktree (filters the board, exactly like clicking a tab). */
  onSelect: (active: ActiveWorktree) => void;
}

/** The overflow-collapse control: a disclosure button carrying the aggregate
 *  (count + a running spinner if any collapsed worktree is live + a diverged
 *  attention badge) over a searchable listbox of the collapsed worktrees. The
 *  trigger reflects the active selection (its branch label + active styling) so the
 *  current worktree is visible without opening the panel. Fully keyboard-driven via
 *  {@link useWorktreeCollapsedSelect}. */
export function WorktreeCollapsedSelect({ tabs, active, onSelect }: WorktreeCollapsedSelectProps) {
  const v = useWorktreeCollapsedSelect({ tabs, active, onSelect });
  const { summary, activeTab } = v;
  const isActive = activeTab !== null;
  const label = activeTab !== null ? activeTab.label : 'Worktrees';

  return (
    <div ref={v.rootRef} className="relative" onBlur={v.onContainerBlur}>
      <button
        ref={v.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={v.open}
        onClick={v.onTriggerClick}
        onKeyDown={v.onTriggerKeyDown}
        title={
          activeTab !== null
            ? worktreeTitle(activeTab)
            : `${summary.count} worktrees${summary.anyRunning ? ' · running' : ''}`
        }
        className={`flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 font-mono text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          isActive
            ? 'border-primary/60 bg-primary/[0.12] text-foreground'
            : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20 hover:text-foreground'
        }`}
      >
        <LayersIcon size={12} className={isActive ? 'text-primary' : 'text-muted-foreground'} />
        <span className="max-w-[160px] truncate">{label}</span>

        <span className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded bg-white/[0.07] px-1 text-[10px] tabular-nums text-muted-foreground">
          {summary.count}
        </span>

        {summary.anyRunning && (
          <span className="flex items-center text-warning">
            <Spinner size={11} />
            <span className="sr-only">{summary.runningCount} running</span>
          </span>
        )}

        {summary.divergedCount > 0 && (
          <span
            className="flex items-center gap-0.5 text-[10px] font-semibold text-warning"
            aria-label={`${summary.divergedCount} diverged`}
          >
            <AlertIcon size={11} />
            {summary.divergedCount}
          </span>
        )}

        <ChevronDownIcon
          size={13}
          className={`ml-0.5 text-muted-foreground transition-transform ${v.open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {v.open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 w-[300px] rounded-[10px] border border-border bg-popover p-1 shadow-2xl"
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-2 pb-1.5 pt-1 transition-colors focus-within:border-primary/60">
            <SearchIcon size={13} className="shrink-0 text-muted-foreground" />
            <input
              ref={v.inputRef}
              type="text"
              role="combobox"
              aria-expanded={v.open}
              aria-controls={v.listboxId}
              aria-autocomplete="list"
              aria-activedescendant={v.activeOptionId}
              aria-label="Search worktrees"
              autoComplete="off"
              spellCheck={false}
              value={v.query}
              placeholder="Search worktrees…"
              onChange={v.onQueryChange}
              onKeyDown={v.onKeyDown}
              className="w-full bg-transparent py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>

          <div
            role="listbox"
            id={v.listboxId}
            aria-label="Worktrees"
            className="mt-1 max-h-64 overflow-y-auto"
          >
            {v.rows.map((row) => (
              <WorktreeSelectRowButton
                key={row.tab.branch ?? '__row__'}
                row={row}
                highlighted={row.index === v.highlight}
                selected={row.tab.branch === active}
                onHighlight={v.onHighlight}
                onSelect={v.selectBranch}
              />
            ))}

            {v.rows.length === 0 && (
              <div role="presentation" className="px-2 py-2 text-[12.5px] text-muted-foreground">
                No matching worktrees
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
