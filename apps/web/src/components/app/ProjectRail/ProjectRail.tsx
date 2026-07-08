import {
  BrandMark,
  IconButton,
  PlusIcon,
  ProjectContextMenu,
  ProjectIcon,
  StatusDot,
} from '@/components/ui';
import { useProjectIconProps } from '@/components/ui/ProjectIcon/ProjectIcon.hooks';

import type { ProjectRailProps } from './ProjectRail.types';

function RailProjectButton({
  project,
  active,
  onPick,
  onEdit,
}: {
  project: ProjectRailProps['switcher']['projects'][number];
  active: boolean;
  onPick: () => void;
  onEdit: () => void;
}) {
  const iconProps = useProjectIconProps(project);
  return (
    <ProjectContextMenu onEdit={onEdit}>
      <button
        type="button"
        title={project.name}
        aria-label={project.name}
        aria-current={active ? 'true' : undefined}
        onClick={onPick}
        className={`flex h-10 w-10 items-center justify-center rounded-[10px] transition-colors ${
          active
            ? 'bg-primary/15 ring-2 ring-primary/50'
            : 'hover:bg-white/[0.06]'
        }`}
      >
        <ProjectIcon {...iconProps} size={22} label={project.name} />
      </button>
    </ProjectContextMenu>
  );
}

/** Classic layout: fixed 64px project rail with brand, squares, and footer. */
export function ProjectRail({
  switcher,
  runningCount,
  onGotoProjects,
}: ProjectRailProps) {
  const { projects, active, onPickProject, onNewProject, onEditProject } = switcher;

  return (
    <aside
      className="flex w-16 flex-none flex-col items-center border-r border-border bg-sidebar py-3"
      aria-label="Projects"
    >
      <button
        type="button"
        onClick={onGotoProjects}
        title="Projects"
        aria-label="Back to Projects"
        className="mb-3 rounded-lg p-1 transition-opacity hover:opacity-80"
      >
        <BrandMark size={28} />
      </button>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto px-1.5">
        {projects.map((p) => (
          <RailProjectButton
            key={p.id}
            project={p}
            active={p.id === active?.id}
            onPick={() => onPickProject(p.id)}
            onEdit={() => onEditProject(p)}
          />
        ))}
        <IconButton label="New project" onClick={onNewProject}>
          <PlusIcon size={18} />
        </IconButton>
      </div>

      {runningCount > 0 && (
        <div className="mt-3 flex flex-col items-center gap-2 border-t border-border pt-3">
          <span
            className="flex items-center gap-1 font-mono text-[9px] text-warning"
            title={`${runningCount} running`}
          >
            <StatusDot colorClass="bg-warning" pulse />
            {runningCount}
          </span>
        </div>
      )}
    </aside>
  );
}
