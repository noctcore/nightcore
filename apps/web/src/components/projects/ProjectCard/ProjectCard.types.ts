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
  /** Stat tiles. `value` is `null` for projects that aren't the active one — their
   *  tasks aren't loaded, so the tile renders a muted "–" rather than a fake 0. */
  stats: { label: string; value: number | null; tone: 'neutral' | 'success' | 'warning' }[];
  activity: string;
}

/** Props for {@link ProjectCard}. */
export interface ProjectCardProps {
  project: ProjectSummary;
  /** Open the project, invoked with its id from the card's identity affordance. */
  onOpen: (id: string) => void;
  /** Open the edit dialog for name & icon. When omitted, the menu entry is hidden. */
  onEdit?: (id: string) => void;
  /** Remove the project from Nightcore (registry-only; files on disk untouched). */
  onDelete?: (id: string) => void;
}
