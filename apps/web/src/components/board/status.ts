import type { TaskStatus } from '@/lib/bridge';

/** The four board columns and the statuses they group (M1 contract §Web board). */
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

/** Whether a status represents an actively running task (pulses its dot). */
export function isActive(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'waiting_approval';
}

/** Tailwind background class for a status dot — maps onto the design tokens. */
export const STATUS_DOT_COLOR: Record<TaskStatus, string> = {
  backlog: 'bg-muted',
  ready: 'bg-info',
  in_progress: 'bg-warning',
  waiting_approval: 'bg-warning',
  done: 'bg-success',
  failed: 'bg-destructive',
};

/** Tailwind text class for a status label. */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  backlog: 'text-muted-foreground',
  ready: 'text-info',
  in_progress: 'text-warning',
  waiting_approval: 'text-warning',
  done: 'text-success',
  failed: 'text-destructive',
};

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}
