/** @file ProjectsView — the Projects landing surface (grid of project cards). */
import { Button, EmptyState, FolderIcon, PlusIcon } from '@/components/ui';

import { ProjectCard } from '../ProjectCard';
import { useProjectSummaries } from './ProjectsView.hooks';
import type { ProjectsViewProps } from './ProjectsView.types';

/** The Projects surface: a grid of project cards backed by the live registry,
 *  plus create/open/delete. Counts derive from the active project's tasks. */
export function ProjectsView({
  projects,
  activeId,
  activeTasks,
  runningProjectIds,
  onOpen,
  onRename,
  onDelete,
  onNewProject,
}: ProjectsViewProps) {
  const summaries = useProjectSummaries({
    projects,
    activeId,
    activeTasks,
    runningProjectIds,
  });

  return (
    <div className="h-full overflow-y-auto px-[30px] py-[26px]">
      <div className="mb-[22px] flex items-center gap-3.5">
        <div>
          <h1 className="text-[23px] font-semibold tracking-tight">Projects</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Each project is a git repo with its own board &amp; settings.
          </p>
        </div>
        <Button className="ml-auto" onClick={onNewProject}>
          <PlusIcon size={14} />
          New project
        </Button>
      </div>

      {summaries.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={32} />}
          title="No projects yet"
          description="Point Nightcore at a git repo to begin. Each project gets its own board, tasks, and settings."
          action={<Button onClick={onNewProject}>Add your first project</Button>}
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4">
          {summaries.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
