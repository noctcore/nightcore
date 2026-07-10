/** Props for the {@link TerminalView} — the global Terminal nav destination. */
import type { WorktreeInfo } from '@/lib/bridge';

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
  onConfinedDefaultChange: (confined: boolean) => void;
}
