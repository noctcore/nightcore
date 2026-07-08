import type { Project, Task } from '@/lib/bridge';

/** Props for {@link ProjectsView}. */
export interface ProjectsViewProps {
  /** All registered projects to render as cards. */
  projects: Project[];
  /** Id of the currently active project, or null when none is active. */
  activeId: string | null;
  /** Tasks of the active project, used to derive live counts (best-effort). */
  activeTasks: Task[];
  runningProjectIds: string[];
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  /** @deprecated Prefer {@link onEdit}. */
  onRename?: (id: string, name: string) => void;
  /** Remove a project from Nightcore (registry-only; files on disk untouched). */
  onDelete: (id: string) => void;
  onNewProject: () => void;
}
