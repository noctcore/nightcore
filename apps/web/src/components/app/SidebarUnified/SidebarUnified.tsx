import {
  AnimatePresence,
  ChevronDownIcon,
  IconTile,
  m,
  PlusIcon,
  popover,
  ProjectContextMenu,
  ProjectIcon,
  ProjectPathLabel,
} from '@/components/ui';
import { useProjectIconProps } from '@/components/ui/ProjectIcon/ProjectIcon.hooks';

import type { ProjectSwitcherRowProps, SidebarUnifiedProps } from './SidebarUnified.types';

function ProjectSwitcherRow({ project, onPick, onEdit, onRemove }: ProjectSwitcherRowProps) {
  const iconProps = useProjectIconProps(project);
  return (
    <ProjectContextMenu onEdit={onEdit} onRemove={onRemove}>
      <button
        type="button"
        onClick={onPick}
        className="group/path-trigger flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.04]"
      >
        <IconTile size="sm" className="h-[22px] w-[22px] rounded-md">
          <ProjectIcon {...iconProps} size={14} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs-plus font-medium">{project.name}</span>
          <ProjectPathLabel
            path={project.path}
            focusable={false}
            className="font-mono text-4xs-plus text-muted-foreground"
          />
        </span>
      </button>
    </ProjectContextMenu>
  );
}

/** Unified sidebar header: project dropdown with icons + context menu. */
export function SidebarUnified({ switcher, collapsed }: SidebarUnifiedProps) {
  const {
    projects,
    active,
    switcherOpen,
    onToggleSwitcher,
    onPickProject,
    onNewProject,
    onEditProject,
    onRemoveProject,
  } = switcher;
  const activeIcon = useProjectIconProps(active ?? { id: '', icon: null, customIconPath: null });

  return (
    <div className="relative px-3 pb-0 pt-2">
      <ProjectContextMenu
        onEdit={() => active && onEditProject(active)}
        onRemove={active === null ? undefined : () => onRemoveProject(active.id)}
      >
        <button
          type="button"
          onClick={onToggleSwitcher}
          title={active?.name ?? 'No project'}
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
          className={`flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-white/[0.04] ${collapsed ? 'justify-center px-0' : ''}`}
        >
          <IconTile size="sm" className="h-[22px] w-[22px] rounded-md">
            <ProjectIcon {...activeIcon} size={14} />
          </IconTile>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-xs-plus2 font-semibold">
                {active?.name ?? 'No project'}
              </span>
              <ChevronDownIcon size={14} className="shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </ProjectContextMenu>

      {!collapsed && <div className="mx-1 mt-1 h-px bg-border/50" />}

      <AnimatePresence>
        {switcherOpen && (
          <m.div
            variants={popover}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: collapsed ? 'left center' : 'top center' }}
            className={
              collapsed
                ? 'absolute left-full top-0 z-40 ml-2 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-2xl'
                : 'absolute left-3 right-3 top-full z-40 mt-1.5 rounded-xl border border-border bg-popover p-1.5 shadow-2xl'
            }
          >
            {collapsed && (
              <div className="px-2.5 pb-1 pt-1 font-mono text-4xs-plus uppercase tracking-[0.18em] text-muted-foreground">
                Projects
              </div>
            )}
            {projects.length === 0 && (
              <div className="px-2.5 py-2 text-xs-flat text-muted-foreground">No projects yet.</div>
            )}
            {projects.map((p) => (
              <ProjectSwitcherRow
                key={p.id}
                project={p}
                onPick={() => onPickProject(p.id)}
                onEdit={() => onEditProject(p)}
                onRemove={() => onRemoveProject(p.id)}
              />
            ))}
            <div className="my-1.5 mx-1 h-px bg-border" />
            <button
              type="button"
              onClick={onNewProject}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs-plus font-semibold text-primary hover:bg-white/[0.04]"
            >
              <PlusIcon size={14} />
              New project
            </button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
