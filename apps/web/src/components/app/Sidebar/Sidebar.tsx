import { NavSidebar } from '../NavSidebar';
import { ProjectRail } from '../ProjectRail';
import { SidebarUnified } from '../SidebarUnified';
import type { SidebarProps } from './Sidebar.types';

/** Sidebar orchestrator: Unified (single column) or Classic (rail + nav). */
export function Sidebar({
  sidebarStyle,
  switcher,
  view,
  nav,
  collapsed,
  runningCount,
  awaitingInputCount,
  version,
  onToggleCollapsed,
  onNavigate,
  onGotoProjects,
  onGotoAwaitingInput,
}: SidebarProps) {
  const navProps = {
    view,
    nav,
    collapsed,
    runningCount,
    awaitingInputCount,
    version,
    onToggleCollapsed,
    onNavigate,
    onGotoProjects,
    onGotoAwaitingInput,
  };

  if (sidebarStyle === 'classic') {
    return (
      <>
        <ProjectRail
          switcher={switcher}
          runningCount={runningCount}
          onGotoProjects={onGotoProjects}
        />
        <NavSidebar {...navProps} showHeader={false} />
      </>
    );
  }

  return (
    <NavSidebar
      {...navProps}
      showHeader
      header={
        <SidebarUnified switcher={switcher} collapsed={collapsed} />
      }
    />
  );
}
