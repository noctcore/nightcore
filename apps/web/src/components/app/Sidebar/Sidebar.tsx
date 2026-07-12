import { SparkIcon } from '@/components/ui';

import { NavSidebar } from '../NavSidebar';
import { ProjectRail } from '../ProjectRail';
import { SidebarUnified } from '../SidebarUnified';
import type { SidebarProps } from './Sidebar.types';

/** A passive "update available" pill for the sidebar footer (T11). The startup
 *  updater probe already runs on launch, but its result was previously discarded —
 *  a ready update stayed invisible unless the user opened Settings → About. This
 *  surfaces it as the bottom-most strip: clicking jumps to Settings (where the
 *  idle-gated install lives). The pill NEVER installs, so it can show even while
 *  runs are active. Collapsed rail: the glyph alone, its `title` carrying the
 *  version. */
function UpdatePill({
  version,
  collapsed,
  onGoto,
}: {
  version: string;
  collapsed: boolean;
  onGoto: () => void;
}) {
  const label = `Update available — v${version} ready to install in Settings → About`;
  return (
    <button
      type="button"
      onClick={onGoto}
      title={label}
      aria-label={label}
      className={`flex items-center gap-2 border-t border-primary/30 bg-primary/[0.08] px-3.5 py-2 text-left text-primary transition-colors hover:bg-primary/[0.15] ${collapsed ? 'justify-center' : ''}`}
    >
      <span className="flex shrink-0 items-center">
        <SparkIcon size={14} />
      </span>
      {!collapsed && <span className="font-mono text-2xs font-semibold">v{version} ready</span>}
    </button>
  );
}

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
  update,
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

  // T11: the update pill node (or null when up to date), shared by both layouts.
  const updatePill =
    update != null ? (
      <UpdatePill version={update.version} collapsed={collapsed} onGoto={update.onGoto} />
    ) : null;

  if (sidebarStyle === 'classic') {
    return (
      <>
        <ProjectRail
          switcher={switcher}
          runningCount={runningCount}
          onGotoProjects={onGotoProjects}
        />
        <NavSidebar
          {...navProps}
          showHeader={false}
          slots={{ footer: footerSlot, updatePill }}
        />
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
        updatePill,
      }}
    />
  );
}
