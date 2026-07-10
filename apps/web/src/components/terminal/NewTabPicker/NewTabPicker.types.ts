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
 *  target list, the spawn, the busy/error state, AND the confined choice; the
 *  picker just surfaces them. The confined checkbox (PR C, decision 1) renders only
 *  on macOS (`confinedAvailable`); its value is the sticky Settings default. */
export interface NewTabPickerProps {
  /** Whether the picker is mounted/visible. */
  open: boolean;
  /** The openable targets: repo root first, then the live worktrees. */
  targets: TerminalTarget[];
  /** Fired with the chosen target's absolute path. */
  onPick: (path: string) => void;
  /** Fired on Esc, click-outside, or Cancel. */
  onClose: () => void;
  /** A spawn error to surface inline (e.g. the 8-session cap, or a fail-closed
   *  confined refusal) WITHOUT closing the picker — so the user sees why nothing
   *  opened. */
  error?: string | null;
  /** A spawn is in flight (a target was picked and is opening). */
  busy?: boolean;
  /** Whether the host supports the opt-in confined shell (macOS only). When false
   *  the confined checkbox is not rendered at all. */
  confinedAvailable: boolean;
  /** Whether the next spawn is confined (Seatbelt write-containment, macOS). */
  confined: boolean;
  /** Toggle the confined choice (the parent persists it as the sticky default). */
  onConfinedChange: (confined: boolean) => void;
}
