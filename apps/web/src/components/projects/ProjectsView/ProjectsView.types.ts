import type { Project, Task } from '@/lib/bridge';

export interface ProjectsViewProps {
  projects: Project[];
  activeId: string | null;
  /** Tasks of the active project, used to derive live counts (best-effort). */
  activeTasks: Task[];
  runningProjectIds: string[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNewProject: () => void;
}
