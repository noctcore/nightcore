import type { Task } from '@/lib/bridge';

export interface ColumnProps {
  title: string;
  tasks: Task[];
  /** The column's status dot color (oklch), from the design palette. */
  dotColor: string;
  /** Roadmap tag rendered beside the column title (e.g. Waiting Approval → M3). */
  badge?: string;
  /** When true and the column is non-empty, render a "Clear" affordance. */
  clearable?: boolean;
  selectedId: string | null;
  /** Task ids that are blocked on an unfinished dependency. */
  blockedIds: Set<string>;
  /** Streamed log-line counts per task id (for the running card's Logs badge). */
  logCounts: Record<string, number>;
  emptyText?: string;
  onSelect: (id: string) => void;
  onRun?: (id: string) => void;
  onCancel?: (id: string) => void;
  onDelete?: (id: string) => void;
  onClear?: () => void;
}
