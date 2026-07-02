/** Open/filter/highlight + keyboard state for the BranchPicker. The .tsx shell is
 *  purely presentational; everything stateful lives here. */
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';
import { useId, useMemo, useState } from 'react';

import type { BranchInfo } from '@/lib/bridge';

import type { BranchPickerView, BranchRow, CreateRow } from './BranchPicker.types';

/** Inputs the hook needs from the BranchPicker props. */
interface UseBranchPickerArgs {
  value: string;
  onChange: (value: string) => void;
  branches: BranchInfo[];
  allowCreate: boolean;
  disabled: boolean;
}

/** The filtered + flat-indexed rows derived from the branch list and query. */
interface BranchRows {
  localRows: BranchRow[];
  remoteRows: BranchRow[];
  createRow: CreateRow | null;
  count: number;
}

/** Filter `branches` by `value` (case-insensitive substring), split local vs
 *  remote, and assign each kept row its flat keyboard-nav index (local → remote →
 *  create) plus a stable option id. The create row appears only when creation is
 *  allowed, the query is non-empty, and no branch name matches it exactly. */
function buildRows(
  branches: BranchInfo[],
  value: string,
  allowCreate: boolean,
  baseId: string,
): BranchRows {
  const query = value.trim().toLowerCase();
  const matches = branches.filter(
    (branch) => query === '' || branch.name.toLowerCase().includes(query),
  );

  let index = 0;
  const localRows = matches
    .filter((branch) => !branch.isRemote)
    .map((branch) => ({ branch, index: index++, id: `${baseId}-opt-${index}` }));
  const remoteRows = matches
    .filter((branch) => branch.isRemote)
    .map((branch) => ({ branch, index: index++, id: `${baseId}-opt-${index}` }));

  const exact = branches.some((branch) => branch.name.toLowerCase() === query);
  const createRow: CreateRow | null =
    allowCreate && query !== '' && !exact
      ? { value, index: index++, id: `${baseId}-create` }
      : null;

  return { localRows, remoteRows, createRow, count: index };
}

/**
 * The BranchPicker's state machine: dropdown visibility, the filtered/grouped
 * rows, the highlighted index, and the input handlers. The component is fully
 * controlled — typing flows straight back through `onChange` (which doubles as the
 * filter query), so this hook holds no copy of the text, only the ephemeral
 * open/highlight UI state. Wrap-around arrow navigation; Enter picks the
 * highlighted row; Esc closes; focus leaving the control closes it.
 */
export function useBranchPicker({
  value,
  onChange,
  branches,
  allowCreate,
  disabled,
}: UseBranchPickerArgs): BranchPickerView {
  const baseId = useId();
  const [openState, setOpen] = useState(false);
  const [rawHighlight, setHighlight] = useState(0);

  const { localRows, remoteRows, createRow, count } = useMemo(
    () => buildRows(branches, value, allowCreate, baseId),
    [branches, value, allowCreate, baseId],
  );

  const open = openState && !disabled;
  // Clamp so a shrinking list can never leave the highlight pointing past the end.
  const highlight = count === 0 ? -1 : Math.min(Math.max(rawHighlight, 0), count - 1);

  function selectBranch(name: string): void {
    onChange(name);
    setOpen(false);
  }

  function selectCreate(): void {
    onChange(value);
    setOpen(false);
  }

  /** Activate whichever row owns the given flat index. */
  function selectIndex(target: number): void {
    if (createRow !== null && target === createRow.index) {
      selectCreate();
      return;
    }
    const row = [...localRows, ...remoteRows].find((entry) => entry.index === target);
    if (row !== undefined) selectBranch(row.branch.name);
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>): void {
    if (disabled) return;
    onChange(e.target.value);
    setOpen(true);
    setHighlight(0);
  }

  function onInputFocus(): void {
    if (disabled) return;
    setOpen(true);
    setHighlight(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlight(0);
        return;
      }
      if (count > 0) setHighlight((highlight + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlight(count - 1);
        return;
      }
      if (count > 0) setHighlight((highlight - 1 + count) % count);
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0) {
        e.preventDefault();
        selectIndex(highlight);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  function onContainerBlur(e: FocusEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  }

  function onHighlight(index: number): void {
    setHighlight(index);
  }

  const activeRow =
    highlight < 0
      ? undefined
      : createRow !== null && highlight === createRow.index
        ? createRow
        : [...localRows, ...remoteRows].find((entry) => entry.index === highlight);

  return {
    open,
    localRows,
    remoteRows,
    createRow,
    hasMatches: localRows.length + remoteRows.length > 0,
    highlight,
    listboxId: `${baseId}-listbox`,
    activeOptionId: open ? activeRow?.id : undefined,
    onInputChange,
    onInputFocus,
    onKeyDown,
    onContainerBlur,
    onHighlight,
    selectBranch,
    selectCreate,
  };
}
