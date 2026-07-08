/** A project view-model for the Projects surface (multi-repo, worktree
 *  isolation). This shape backs the project cards: repo identity, running
 *  state, stat tiles, and a relative last-activity label. */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  customIconPath: string | null;
  running: boolean;
  stats: { label: string; value: number; tone: 'neutral' | 'success' | 'warning' }[];
  activity: string;
}

/** Props for {@link ProjectCard}. */
export interface ProjectCardProps {
  project: ProjectSummary;
  /** Open the project, invoked with its id from the card's identity affordance. */
  onOpen: (id: string) => void;
  /** Open the edit dialog for name & icon. When omitted, the menu entry is hidden. */
  onEdit?: (id: string) => void;
  /** @deprecated Use {@link onEdit} — kept for tests that still call rename directly. */
  onRename?: (id: string, name: string) => void;
  /** Remove the project from Nightcore (registry-only; files on disk untouched). */
  onDelete?: (id: string) => void;
}
