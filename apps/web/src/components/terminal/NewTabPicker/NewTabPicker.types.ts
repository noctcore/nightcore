/** Props + target shape for the new-terminal picker. */

/** A place a new terminal can open: the repo root or one of the project's
 *  worktrees. `path` is the absolute cwd handed to the spawn (re-validated +
 *  confined to the project server-side — the webview's value is never trusted). */
export interface TerminalTarget {
  /** `repo` = the project root, `worktree` = a `.nightcore/worktrees/<id>` dir. */
  kind: 'repo' | 'worktree';
  /** Display label — the project name for the repo root, the branch for a worktree. */
  label: string;
  /** Absolute cwd. */
  path: string;
  /** Optional secondary line (a compact path or task hint). */
  detail?: string;
}

/** Props for the {@link NewTabPicker} modal. Presentational: the parent owns the
 *  target list, the spawn, and the busy/error state; the picker just surfaces
 *  them. NO confined checkbox in PR B — spawn is always unconfined (the toggle is
 *  PR C). */
export interface NewTabPickerProps {
  /** Whether the picker is mounted/visible. */
  open: boolean;
  /** The openable targets: repo root first, then the live worktrees. */
  targets: TerminalTarget[];
  /** Fired with the chosen target's absolute path. */
  onPick: (path: string) => void;
  /** Fired on Esc, click-outside, or Cancel. */
  onClose: () => void;
  /** A spawn error to surface inline (e.g. the 8-session cap) WITHOUT closing the
   *  picker — so the user sees why nothing opened. */
  error?: string | null;
  /** A spawn is in flight (a target was picked and is opening). */
  busy?: boolean;
}
