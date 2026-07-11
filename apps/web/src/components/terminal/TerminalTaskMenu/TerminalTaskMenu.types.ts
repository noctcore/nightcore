import type { Task, TerminalSessionInfo } from '@/lib/bridge';

/** Props for {@link TerminalTaskMenu} — the header task dropdown (cockpit spec PR 4,
 *  decision 2). Purely presentational; the parent owns the task list + injection. */
export interface TerminalTaskMenuProps {
  /** The pre-run tasks to offer (already filtered + sorted, most-recent first). */
  tasks: readonly Task[];
  /** The terminal a pick injects into (the active tab/pane). `null` disables the
   *  dropdown — there is nowhere to inject. */
  activeSession: TerminalSessionInfo | null;
  /** Inject the picked task's context into `activeSession` (a user gesture). */
  onPick: (session: TerminalSessionInfo, task: Task) => void;
}
