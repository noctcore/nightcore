/** Shared types for the new-project dialog. */

import type { ProjectIconImageDraft } from '@/components/ui';

/** Values collected by the dialog and passed to `onCreate`. */
export interface NewProjectDraft {
  folder: string | null;
  name: string;
  icon: string | null;
  customImage: ProjectIconImageDraft | null;
}

/** Git-repo status for the chosen folder. `create_project` requires `valid`. */
export type NewProjectGitState = 'unknown' | 'checking' | 'valid' | 'invalid';

/** Props for `NewProjectDialog`. */
export interface NewProjectDialogProps {
  /** Presence flag — the dialog scales in/out and stays mounted while closed. */
  open: boolean;
  onChooseFolder: () => void | Promise<void>;
  onCreate: (draft: NewProjectDraft) => void | Promise<void>;
  onClose: () => void;
  /** Pre-selected folder once chosen (drives the create button's enabled state). */
  folder?: string | null;
  /** Whether the chosen folder is a git repo. Gates Create + offers `git init`. */
  gitState?: NewProjectGitState;
  /** Run `git init` in the chosen folder (offered when `gitState === 'invalid'`). */
  onInitGit?: () => void | Promise<void>;
}
