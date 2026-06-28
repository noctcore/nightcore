/** A project view-model for the Projects surface (multi-repo, worktree
 *  isolation). This shape backs the project cards: repo identity, running
 *  state, stat tiles, and a relative last-activity label. */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  running: boolean;
  stats: { label: string; value: number; tone: 'neutral' | 'success' | 'warning' }[];
  activity: string;
}

/** Props for {@link ProjectCard}. */
export interface ProjectCardProps {
  project: ProjectSummary;
  /** Open the project, invoked with its id from the card's identity affordance. */
  onOpen: (id: string) => void;
  /** Rename the project to `name` (registry-only; files on disk untouched). When
   *  omitted, the kebab menu and its actions are not rendered. */
  onRename?: (id: string, name: string) => void;
  /** Remove the project from Nightcore (registry-only; files on disk untouched). */
  onDelete?: (id: string) => void;
}
