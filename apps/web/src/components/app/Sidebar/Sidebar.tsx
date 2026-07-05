import {
  AnimatePresence,
  BellIcon,
  BrandMark,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GithubIcon,
  IconButton,
  IconTile,
  Kbd,
  m,
  PlusIcon,
  popover,
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
  awaitingInputCount,
  version,
  onToggleCollapsed,
  onToggleSwitcher,
  onNavigate,
  onGotoProjects,
  onPickProject,
  onNewProject,
  onGotoAwaitingInput,
}: SidebarProps) {
  return (
    <aside
      className="flex flex-col border-r border-border bg-sidebar transition-[width] duration-150"
      style={{ width: collapsed ? 66 : 244, flex: 'none' }}
    >
      {/* brand — clicking the logo returns to the full-screen Projects view */}
      <div
        className={`flex items-center gap-2.5 px-4 py-3.5 ${collapsed ? 'flex-col' : ''}`}
      >
        <button
          type="button"
          onClick={onGotoProjects}
          title="Projects"
          aria-label="Back to Projects"
          className={`flex min-w-0 items-center gap-2.5 rounded-lg text-left transition-opacity hover:opacity-80 ${collapsed ? 'flex-col' : 'flex-1'}`}
        >
          <BrandMark size={30} />
          {!collapsed && (
            <span className="flex-1 text-lg font-semibold tracking-tight">
              nightcore<span className="text-primary">.</span>
            </span>
          )}
        </button>
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
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
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
              <div className="px-2.5 pb-1 pt-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground">
                Projects
              </div>
            )}
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
          </m.div>
        )}
        </AnimatePresence>
      </div>

      {/* workspace nav */}
      {!collapsed && (
        <div className="px-[18px] pb-1.5 pt-3.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground">
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
              aria-current={isActive ? 'page' : undefined}
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

      {/* awaiting-input indicator: always visible on every view, so a background
          run parked on a permission/question prompt is never hidden behind a
          non-board surface. Clicking jumps to the parked task's board drawer. */}
      {awaitingInputCount > 0 && (
        <button
          type="button"
          onClick={onGotoAwaitingInput}
          title={`${awaitingInputCount} awaiting your input`}
          aria-label={`${awaitingInputCount} task${awaitingInputCount === 1 ? '' : 's'} awaiting your input`}
          className={`mt-auto flex items-center gap-2 border-t border-border bg-warning/[0.06] px-3.5 py-2.5 text-left text-warning transition-colors hover:bg-warning/[0.12] ${collapsed ? 'justify-center' : ''}`}
        >
          <span className="flex shrink-0 animate-[nc-pulse_1.4s_ease-in-out_infinite] items-center">
            <BellIcon size={14} />
          </span>
          {!collapsed ? (
            <span className="font-mono text-[11px] font-semibold">
              {awaitingInputCount} awaiting input
            </span>
          ) : (
            awaitingInputCount > 1 && (
              <span className="font-mono text-[10px] font-semibold">
                {awaitingInputCount}
              </span>
            )
          )}
        </button>
      )}

      {/* footer: running-agents indicator + version */}
      <div
        className={`flex items-center gap-2.5 border-t border-border px-3.5 py-3 ${awaitingInputCount > 0 ? '' : 'mt-auto'} ${collapsed ? 'justify-center' : ''}`}
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
