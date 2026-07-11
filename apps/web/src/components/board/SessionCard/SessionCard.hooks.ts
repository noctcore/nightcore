/** Collapse-state hooks and the collapsed-summary helper for the Session/History
 *  cards. */
import { useState } from 'react';

import type { Task } from '@/lib/bridge';

import { KIND_LABEL, modelBadge, PERMISSION_MODE_LABEL, RUN_MODE_LABEL } from '../status';

/** The Session card's collapse state. Collapsed by default; opens once at mount
 *  when the task is still editable (`kindEditable`) so a fresh backlog/ready task
 *  surfaces its config without a click. The initializer runs once — toggling is
 *  never fought by re-renders. */
export function useSessionCard(kindEditable: boolean): {
  open: boolean;
  toggle: () => void;
} {
  const [open, setOpen] = useState(kindEditable);
  return { open, toggle: () => setOpen((v) => !v) };
}

/** The History card's collapse state. Collapsed by default (unlike the Session
 *  card) — history is a secondary, on-demand surface. The initializer runs once. */
export function useHistoryCard(): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen((v) => !v) };
}

/** A compact middot-joined one-line summary of a task's session configuration,
 *  for the collapsed Session card. Reuses the shared label maps so it stays in
 *  lockstep with the expanded pickers/pills. Pure. */
export function summarizeSession(task: Task): string {
  const permission =
    task.permissionMode !== null ? PERMISSION_MODE_LABEL[task.permissionMode] : 'Inherit';
  const modelEffort =
    modelBadge(task).label + (task.effort !== null ? `·${task.effort}` : '');
  const turns = task.maxTurns !== null ? `${task.maxTurns} turns` : '∞ turns';
  const limits = task.maxBudgetUsd !== null ? `${turns} · $${task.maxBudgetUsd}` : turns;
  return [
    KIND_LABEL[task.kind],
    RUN_MODE_LABEL[task.runMode],
    permission,
    modelEffort,
    limits,
  ].join(' · ');
}
