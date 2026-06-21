/** A project view-model for the Projects surface. Projects are an M2 concept
 *  (multi-repo, worktree isolation); this shape backs the design's project
 *  cards ahead of the Rust-side registry landing. */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  running: boolean;
  stats: { label: string; value: number; tone: 'neutral' | 'success' | 'warning' }[];
  activity: string;
}

export interface ProjectCardProps {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  /** Rename the project to `name` (registry-only; files on disk untouched). When
   *  omitted, the kebab menu and its actions are not rendered. */
  onRename?: (id: string, name: string) => void;
  /** Remove the project from Nightcore (registry-only; files on disk untouched). */
  onDelete?: (id: string) => void;
}
