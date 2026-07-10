/** Props for the {@link TerminalReadonlyPane} — a restored (dead) session's
 *  read-only scrollback replay (decision 3). */
import type { PersistedTerminalInfo } from '@/lib/bridge';

export interface TerminalReadonlyPaneProps {
  /** The persisted session this pane replays (metadata; the bytes are fetched by
   *  the pane's hook via `terminal_read_persisted`). */
  info: PersistedTerminalInfo;
  /** Whether a fresh shell can be started in the session's original cwd — false
   *  when that folder is no longer a valid spawn target (its worktree was removed).
   *  Gates the "start a fresh shell here" action. */
  canRestore: boolean;
  /** Start a fresh live shell in the session's cwd (the parent spawns + swaps this
   *  read-only tab for the new live one). */
  onRestore: () => void;
}
