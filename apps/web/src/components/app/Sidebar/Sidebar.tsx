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
  footerSlot,
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
        <NavSidebar {...navProps} showHeader={false} slots={{ footer: footerSlot }} />
      </>
    );
  }

  return (
    <NavSidebar
      {...navProps}
      showHeader
      slots={{
        header: <SidebarUnified switcher={switcher} collapsed={collapsed} />,
        footer: footerSlot,
      }}
    />
  );
}
