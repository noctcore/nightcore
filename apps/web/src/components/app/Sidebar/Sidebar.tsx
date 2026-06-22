import {
  BrandMark,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GithubIcon,
  IconButton,
  IconTile,
  Kbd,
  PlusIcon,
  StatusDot,
} from '@/components/ui';
import type { SidebarProps } from './Sidebar.types';

const NAV_BASE =
  'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors cursor-pointer';

/** The app sidebar: brand, project switcher (active project + dropdown), the
 *  Board/Projects/Settings nav, and a footer with the running-agents indicator
 *  and version. Collapsible. Presentational — all state is owned by the shell. */
export function Sidebar({
  projects,
  active,
  view,
  nav,
  collapsed,
  switcherOpen,
  runningCount,
  version,
  onToggleCollapsed,
  onToggleSwitcher,
  onNavigate,
  onPickProject,
  onNewProject,
}: SidebarProps) {
  return (
    <aside
      className="flex flex-col border-r border-border bg-sidebar transition-[width] duration-150"
      style={{ width: collapsed ? 66 : 244, flex: 'none' }}
    >
      {/* brand */}
      <div
        className={`flex items-center gap-2.5 px-4 py-3.5 ${collapsed ? 'flex-col' : ''}`}
      >
        <BrandMark size={30} />
        {!collapsed && (
          <span className="flex-1 text-lg font-semibold tracking-tight">
            nightcore<span className="text-primary">.</span>
          </span>
        )}
        <IconButton label="Toggle sidebar" onClick={onToggleCollapsed}>
          {collapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
        </IconButton>
      </div>

      {/* project switcher */}
      <div className="relative px-3 pb-1 pt-1.5">
        <button
          type="button"
          onClick={onToggleSwitcher}
          title={active?.name ?? 'No project'}
          className={`flex w-full items-center gap-2.5 rounded-[9px] border border-border bg-white/[0.02] px-2.5 py-2.5 text-left ${collapsed ? 'justify-center' : ''}`}
        >
          <IconTile size="sm" className="h-[22px] w-[22px] rounded-md">
            <FolderIcon size={14} />
          </IconTile>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">
                  {active?.name ?? 'No project'}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {active?.path ?? 'Select a project'}
                </span>
              </span>
              <ChevronDownIcon size={15} className="shrink-0 text-muted-foreground" />
            </>
          )}
        </button>

        {switcherOpen && (
          <div
            className="absolute left-3 right-3 top-full z-40 mt-1.5 rounded-xl border border-border bg-popover p-1.5 shadow-2xl"
            style={{ animation: 'nc-rise .14s ease' }}
          >
            {projects.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-muted-foreground">
                No projects yet.
              </div>
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPickProject(p.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.04]"
              >
                <StatusDot colorClass={p.id === active?.id ? 'bg-primary' : 'bg-muted'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {p.name}
                  </span>
                  <span className="block truncate font-mono text-[9.5px] text-muted-foreground">
                    {p.path}
                  </span>
                </span>
              </button>
            ))}
            <div className="my-1.5 mx-1 h-px bg-border" />
            <button
              type="button"
              onClick={onNewProject}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold text-primary hover:bg-white/[0.04]"
            >
              <PlusIcon size={14} />
              New project
            </button>
          </div>
        )}
      </div>

      {/* workspace nav */}
      {!collapsed && (
        <div className="px-[18px] pb-1.5 pt-3.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
          Workspace
        </div>
      )}
      <nav className="flex flex-col gap-0.5 px-3">
        {nav.map((item) => {
          const isActive = item.view === view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              title={item.label}
              className={`${NAV_BASE} ${collapsed ? 'justify-center' : ''} ${
                isActive
                  ? 'bg-primary/[0.12] text-primary'
                  : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="flex-1 text-[13px] font-medium">{item.label}</span>
                  <Kbd>{item.hint}</Kbd>
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* footer: running-agents indicator + version */}
      <div
        className={`mt-auto flex items-center gap-2.5 border-t border-border px-3.5 py-3 ${collapsed ? 'justify-center' : ''}`}
      >
        {runningCount > 0 ? (
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-warning">
            <StatusDot colorClass="bg-warning" pulse />
            {!collapsed && `${runningCount} running`}
          </span>
        ) : (
          !collapsed && (
            <span className="font-mono text-[11px] text-muted-foreground">{version}</span>
          )
        )}
        <a
          href="https://github.com/Shironex/nightcore"
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
          title="View on GitHub"
          className={`flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground ${collapsed ? '' : 'ml-auto'}`}
        >
          <GithubIcon size={16} />
        </a>
      </div>
    </aside>
  );
}
