import type { Task } from '@/lib/bridge';

/** A tripped circuit breaker: the autonomous loop paused after consecutive
 *  failures. Drives the board's dismissable Resume banner. */
export interface BreakerInfo {
  /** Consecutive-failure count that tripped the breaker (`failureThreshold`). */
  failureThreshold: number;
}

export interface BoardProps {
  tasks: Task[];
  /** Active project path + branch for the header subtitle. */
  projectPath: string;
  projectBranch: string | null;
  /** Live max-concurrency (from `nc:loop`, falling back to persisted settings). */
  concurrency: number;
  /** Whether the autonomous loop is running (reflects `nc:loop`, not local state). */
  autoMode: boolean;
  /** Set when the circuit breaker tripped; drives the Resume banner. */
  breaker: BreakerInfo | null;
  selectedId: string | null;
  /** Streamed log-line counts per task id (running card Logs badge). */
  logCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Clear all tasks in a column (Verified/Failed). */
  onClearColumn: (statuses: Task['status'][]) => void;
  /** Start/stop the autonomous loop (the header Auto Mode toggle). */
  onToggleAutoMode: () => void;
  /** Resize the live agent pool (the header concurrency slider). */
  onConcurrencyChange: (n: number) => void;
  /** Resume the loop after a circuit-breaker pause. */
  onResume: () => void;
}
