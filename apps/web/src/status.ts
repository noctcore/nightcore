import type { TaskStatus } from './bridge';

/** The four board columns and the statuses they group. */
export interface ColumnDef {
  key: string;
  title: string;
  statuses: TaskStatus[];
}

export const COLUMNS: ColumnDef[] = [
  { key: 'backlog', title: 'Backlog', statuses: ['backlog', 'ready'] },
  {
    key: 'in_progress',
    title: 'In Progress',
    statuses: ['in_progress', 'waiting_approval'],
  },
  { key: 'done', title: 'Done', statuses: ['done'] },
  { key: 'failed', title: 'Failed', statuses: ['failed'] },
];

/** Human label for a status. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'Running',
  waiting_approval: 'Awaiting approval',
  done: 'Done',
  failed: 'Failed',
};

/** Tailwind background class for a status dot. */
export const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'bg-zinc-500',
  ready: 'bg-indigo-400',
  in_progress: 'bg-sky-400 animate-pulse',
  waiting_approval: 'bg-amber-400 animate-pulse',
  done: 'bg-emerald-400',
  failed: 'bg-rose-400',
};

/** Tailwind text class for a status. */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  backlog: 'text-zinc-400',
  ready: 'text-indigo-300',
  in_progress: 'text-sky-300',
  waiting_approval: 'text-amber-300',
  done: 'text-emerald-300',
  failed: 'text-rose-300',
};

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}
