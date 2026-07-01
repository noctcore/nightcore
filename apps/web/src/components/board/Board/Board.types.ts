/** Prop and supporting types for the Board component. */
import type { BoardAppearance, Task, WorktreeInfo } from '@/lib/bridge';
import type { PickedBackgroundImage } from '../BoardBackgroundPanel';
import type { ActiveWorktree } from '../WorktreeSwitcher';

/** A tripped circuit breaker: the autonomous loop paused after consecutive
 *  failures. Drives the board's dismissable Resume banner. */
export interface BreakerInfo {
  /** Consecutive-failure count that tripped the breaker (`failureThreshold`). */
  failureThreshold: number;
}

/** Props for the Board: the tasks, project/worktree context, loop state, and the
 *  full set of card/header action handlers (owned by the shell). */
export interface BoardProps {
  tasks: Task[];
  /** Active project id — scopes the per-project board background/appearance. */
  projectId: string;
  /** Active project name + path + branch for the header (and the inspector). */
  projectName: string;
  projectPath: string;
  projectBranch: string | null;
  /** This project's raw board-appearance override (Custom Background), or `null` when
   *  it hasn't been customized — the board normalizes it to the defaults. */
  appearanceOverride: BoardAppearance | null;
  /** This project's background image `version` (cache-bust key), or `null` when no
   *  custom background is set. */
  backgroundVersion: number | null;
  /** Persist a board-appearance knob change (the panel sends the full next set). */
  onChangeAppearance: (next: BoardAppearance) => void;
  /** Persist a newly picked background image. */
  onPickBackground: (image: PickedBackgroundImage) => Promise<void> | void;
  /** Clear the current background image. */
  onClearBackground: () => Promise<void> | void;
  /** Live worktrees for the switcher; empty falls back to task branches. */
  worktrees: WorktreeInfo[];
  /** The selected worktree tab (`null` = Main); filters the board. */
  activeWorktree: ActiveWorktree;
  /** Select a worktree tab (sets the active worktree + filters the board). */
  onSelectWorktree: (active: ActiveWorktree) => void;
  /** Live max-concurrency (from `nc:loop`, falling back to persisted settings). */
  concurrency: number;
  /** Whether the autonomous loop is running (reflects `nc:loop`, not local state). */
  autoMode: boolean;
  /** Auto Mode option: auto-commit each task once it's verified (persisted). */
  autoCommitOnVerified: boolean;
  /** Set when the circuit breaker tripped; drives the Resume banner. */
  breaker: BreakerInfo | null;
  selectedId: string | null;
  /** Streamed log-line counts per task id (running card Logs badge). */
  logCounts: Record<string, number>;
  /** Backend-computed blocked-task ids (deps unsatisfied). Drives the blocked
   *  chip + locked Run; owned by the shell so it refreshes on `nc:task`. */
  blockedIds: Set<string>;
  /** Task ids with a parked permission prompt — drives the card's pulse. */
  promptIds: Set<string>;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Drag a card to another column → set its status (rejected into In Progress). */
  onMoveTask: (id: string, status: Task['status']) => void;
  /** Clear all tasks in a column (Verified/Failed). */
  onClearColumn: (statuses: Task['status'][]) => void;
  /** Waiting Approval card actions. */
  onApprove: (id: string) => void;
  onRefine: (id: string) => void;
  /** Verified card actions. */
  onCommit: (id: string) => void;
  onMerge: (id: string) => void;
  isActionPending?: (action: string, id: string) => boolean;
  /** Start/stop the autonomous loop (the header Auto Mode toggle). */
  onToggleAutoMode: () => void;
  /** Persist the auto-commit-on-verified Auto Mode option (the gear popover). */
  onAutoCommitChange: (next: boolean) => void;
  /** Resize the live agent pool (the header concurrency slider). */
  onConcurrencyChange: (n: number) => void;
  /** Resume the loop after a circuit-breaker pause. */
  onResume: () => void;
}
