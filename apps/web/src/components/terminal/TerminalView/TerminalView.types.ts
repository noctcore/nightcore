/** Props for the {@link TerminalView} — the global Terminal nav destination. */
import type { Task, WorktreeInfo } from '@/lib/bridge';

/** Props for the Terminal view. The repo root + name frame the new-tab picker's
 *  "repo root" target; the live worktrees (read from the shared worktrees context
 *  by the view) are the other targets. The two toggles arrive from the resolved
 *  Settings (the terminal reaches them via the shell, not the settings feature). */
export interface TerminalViewProps {
  /** The active project's root path — the repo-root spawn target. `null` outside a
   *  project (the picker then shows only its empty note). */
  projectPath: string | null;
  /** The active project's name — the repo-root target's label. */
  projectName: string | null;
  /** Settings GPU toggle (decision 7): new sessions load the WebGL renderer when
   *  true, else DOM. */
  webglEnabled: boolean;
  /** Settings sticky default for the confined checkbox (decision 1). */
  confinedDefault: boolean;
  /** Settings terminal font size in px, or `null` for the shipped default (spec
   *  PR 3d). Applied to live terminals reactively via the session manager. */
  fontSize: number | null;
  /** Settings terminal scrollback length in lines, or `null` for the shipped default
   *  (spec PR 3d). */
  scrollback: number | null;
  /** The active project's tasks (cockpit spec PR 4, decision 2): the header dropdown's
   *  pickable list + the source for a linked task's title. */
  tasks: Task[];
  /** Settings YOLO launch flag (decision 3/4e): when true the composed "Launch Claude"
   *  command appends `--dangerously-skip-permissions`. */
  yoloLaunch: boolean;
  /** Settings AI tab auto-naming flag (round-2 PR A): when true, a non-trivial command
   *  in a tab whose title isn't manually/task-locked triggers a haiku one-shot that
   *  suggests a 2–3-word title. Default off (opt-in). */
  aiNaming: boolean;
  /** Persist the confined choice actually used, so it seeds the next picker open. */
  onConfinedDefaultChange: (confined: boolean) => void;
}

/** Input to {@link useTerminalView}: the view props plus the worktrees the shell
 *  passes down from the shared context. */
export interface UseTerminalViewInput {
  projectPath: string | null;
  projectName: string | null;
  worktrees: WorktreeInfo[];
  webglEnabled: boolean;
  confinedDefault: boolean;
  fontSize: number | null;
  scrollback: number | null;
  tasks: Task[];
  yoloLaunch: boolean;
  aiNaming: boolean;
  onConfinedDefaultChange: (confined: boolean) => void;
}
