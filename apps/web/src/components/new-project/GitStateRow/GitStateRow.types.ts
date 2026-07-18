import type { NewProjectGitState } from '../NewProjectDialog/NewProjectDialog.types';

/** Props for {@link GitStateRow}. */
export interface GitStateRowProps {
  /** Git-repo status of the chosen folder. `unknown` renders nothing. */
  gitState: NewProjectGitState;
  /** Offered as a `git init` recovery action when `gitState === 'invalid'`. */
  onInitGit?: () => void | Promise<void>;
}
