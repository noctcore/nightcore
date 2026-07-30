import {
  BellIcon,
  BrandMark,
  ChevronDownIcon,
  GithubIcon,
  Kbd,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  QuestionIcon,
  StatusDot,
} from '@/components/ui';
import type { StageMeta } from '@/lib/stages';

import type { NavItem } from '../AppShell/AppShell.types';
import { type NavSection,useNavSidebarSections } from './NavSidebar.hooks';
import type { NavSidebarProps } from './NavSidebar.types';

const NAV_BASE =
  'flex items-center gap-2.5 rounded-nc px-2.5 py-2 text-left transition-colors cursor-pointer';

function SidebarCollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className="group/toggle absolute -right-3.5 top-10 z-50 flex h-7 w-7 items-center justify-center rounded-full border border-border/80 bg-card/95 text-muted-foreground shadow-lg shadow-black/5 backdrop-blur-sm transition-all duration-[var(--nc-motion-fast)] ease-[var(--nc-ease-out-quint)] hover:scale-110 hover:border-primary/30 hover:bg-accent/80 hover:text-primary hover:shadow-xl hover:shadow-primary/10 active:scale-90"
    >
      {collapsed ? (
        <PanelLeftIcon size={14} className="pointer-events-none transition-transform duration-[var(--nc-motion-fast)]" />
      ) : (
        <PanelLeftCloseIcon
          size={14}
          className="pointer-events-none transition-transform duration-[var(--nc-motion-fast)]"
        />
      )}
      <span className="pointer-events-none absolute left-full ml-3 translate-x-1 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground opacity-0 shadow-lg transition-all duration-[var(--nc-motion-fast)] group-hover/toggle:translate-x-0 group-hover/toggle:opacity-100">
        {label}
      </span>
    </button>
  );
}

function NavItemButton({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: (view: NavItem['view']) => void;
}) {
  return (
    <button
      key={item.view}
      type="button"
      onClick={() => onNavigate(item.view)}
      title={collapsed ? `${item.label} (${item.hint})` : undefined}
      aria-current={active ? 'page' : undefined}
      className={`${NAV_BASE} ${collapsed ? 'justify-center' : ''} ${
        active
          ? 'bg-primary/[0.12] text-primary'
          : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
      }`}
    >
      <span className="shrink-0">{item.icon}</span>
      {!collapsed && (
        <>
          <span className="flex-1 text-xs-plus2 font-medium">{item.label}</span>
          <Kbd>{item.hint}</Kbd>
        </>
      )}
    </button>
  );
}

/** The stage explainer: what this stage of the lifecycle actually does, and what it
 *  leaves behind. Revealed from the group header's `?` toggle — the stage NAMES were
 *  already in the chrome and said nothing (issue #404). Copy comes from the shared
 *  lifecycle table, the same source the onboarding stage diagram renders. */
function StageExplainer({ stage }: { stage: StageMeta }) {
  return (
    <div className="mb-1 mt-1 rounded-nc border border-border/60 bg-white/[0.02] px-2.5 py-2">
      <p className="text-2xs leading-snug text-muted-foreground">{stage.summary}</p>
      <p className="mt-1.5 font-mono text-4xs-plus uppercase leading-snug tracking-[0.08em] text-muted-foreground/70">
        leaves behind: {stage.produces}
      </p>
    </div>
  );
}

/** The `?` disclosure beside a stage group's header. A real button with an
 *  `aria-expanded` state and a spelled-out accessible name, so the explainer is
 *  reachable by keyboard and announced, not a hover-only tooltip (which the nav's
 *  `overflow-y-auto` would clip anyway). */
function StageExplainerToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} what the ${label} stage means`}
      className={`ml-auto flex shrink-0 cursor-pointer items-center rounded p-0.5 transition-colors hover:text-foreground ${
        open ? 'text-primary' : 'text-muted-foreground/45'
      }`}
    >
      <QuestionIcon size={12} />
    </button>
  );
}

function NavGroupSection({
  section,
  sectionIndex,
  view,
  collapsed,
  isCollapsed,
  explainer,
  onToggle,
  onNavigate,
}: {
  section: NavSection;
  sectionIndex: number;
  view: NavSidebarProps['view'];
  collapsed: boolean;
  isCollapsed: boolean;
  /** Stage-explainer disclosure state for this section (absent on non-stage groups). */
  explainer: { open: boolean; onToggle: () => void };
  onToggle: () => void;
  onNavigate: NavSidebarProps['onNavigate'];
}) {
  const showItems = collapsed || !isCollapsed;
  const showHeader = !collapsed && !section.footer;
  const stage = section.explainer;

  return (
    <div className={sectionIndex > 0 && !collapsed ? 'mt-3' : ''}>
      {showHeader && (
        <div className="mb-1 flex items-center gap-1 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => section.collapsible && onToggle()}
            disabled={!section.collapsible}
            className={`group flex min-w-0 flex-1 items-center rounded-md ${
              section.collapsible
                ? 'cursor-pointer hover:bg-white/[0.03]'
                : 'cursor-default'
            }`}
          >
            <span className="font-mono text-4xs-plus uppercase tracking-[0.18em] text-muted-foreground">
              {section.label}
            </span>
            {section.collapsible && (
              <ChevronDownIcon
                size={12}
                className={`ml-auto text-muted-foreground transition-transform duration-[var(--nc-motion-fast)] ${
                  isCollapsed ? '-rotate-90' : ''
                }`}
              />
            )}
          </button>
          {stage !== undefined && (
            <StageExplainerToggle
              label={section.label}
              open={explainer.open}
              onToggle={explainer.onToggle}
            />
          )}
        </div>
      )}

      {!collapsed && stage !== undefined && explainer.open && <StageExplainer stage={stage} />}

      {collapsed && sectionIndex > 0 && <div className="mx-2 my-1.5 h-px bg-border/30" />}

      {showItems && (
        <div className="flex flex-col gap-0.5">
          {section.items.map((item) => (
            <NavItemButton
              key={item.view}
              item={item}
              active={item.view === view}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}

      {/* Stage note (e.g. Verify): a muted, non-interactive caption under the
          group's items explaining a stage whose surface lives elsewhere. Hidden
          in the collapsed rail (no room for prose). */}
      {!collapsed && showItems && section.note !== undefined && (
        <p className="mt-1 px-2.5 text-2xs leading-snug text-muted-foreground/70">
          {section.note}
        </p>
      )}
    </div>
  );
}

/** Shared nav column: optional header, workspace nav, awaiting-input strip, footer. */
export function NavSidebar({
  view,
  nav,
  collapsed,
  runningCount,
  awaitingInputCount,
  version,
  showHeader,
  onToggleCollapsed,
  onNavigate,
  onGotoProjects,
  onGotoAwaitingInput,
  slots,
}: NavSidebarProps) {
  const { sections, toggleSection, isSectionCollapsed, explainedStage, toggleExplainer } =
    useNavSidebarSections(nav);
  const mainSections = sections.filter((section) => !section.footer);
  const footerSections = sections.filter((section) => section.footer);

  return (
    <aside
      className="relative mt-1.5 flex flex-col border-r border-t border-border bg-sidebar transition-[width] duration-[var(--nc-motion-fast)]"
      style={{ width: collapsed ? 66 : 244, flex: 'none' }}
    >
      <SidebarCollapseToggle collapsed={collapsed} onToggle={onToggleCollapsed} />

      {showHeader && (
        <div className={`flex items-center gap-2.5 px-4 py-3.5 ${collapsed ? 'flex-col' : ''}`}>
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
        </div>
      )}

      {slots?.header}

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2">
        {mainSections.map((section, index) => (
          <NavGroupSection
            key={section.id}
            section={section}
            sectionIndex={index}
            view={view}
            collapsed={collapsed}
            isCollapsed={isSectionCollapsed(section.id, section.collapsible)}
            explainer={{
              open: explainedStage === section.id,
              onToggle: () => toggleExplainer(section.id),
            }}
            onToggle={() => toggleSection(section.id)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {awaitingInputCount > 0 && (
        <button
          type="button"
          onClick={onGotoAwaitingInput}
          title={`${awaitingInputCount} awaiting your input`}
          aria-label={`${awaitingInputCount} task${awaitingInputCount === 1 ? '' : 's'} awaiting your input`}
          className={`mt-auto flex shrink-0 items-center gap-2 border-t border-border bg-warning/[0.06] px-3.5 py-2.5 text-left text-warning transition-colors hover:bg-warning/[0.12] ${collapsed ? 'justify-center' : ''}`}
        >
          <span className="flex shrink-0 animate-[nc-pulse_1.4s_ease-in-out_infinite] items-center">
            <BellIcon size={14} />
          </span>
          {!collapsed ? (
            <span className="font-mono text-2xs font-semibold">
              {awaitingInputCount} awaiting input
            </span>
          ) : (
            awaitingInputCount > 1 && (
              <span className="font-mono text-3xs font-semibold">{awaitingInputCount}</span>
            )
          )}
        </button>
      )}

      {footerSections.length > 0 && (
        <nav
          className={`flex shrink-0 flex-col gap-0.5 px-3 py-2 ${awaitingInputCount > 0 ? '' : 'mt-auto'}`}
        >
          {footerSections.map((section, index) => (
            <NavGroupSection
              key={section.id}
              section={section}
              sectionIndex={index}
              view={view}
              collapsed={collapsed}
              isCollapsed={isSectionCollapsed(section.id, section.collapsible)}
              explainer={{
                open: explainedStage === section.id,
                onToggle: () => toggleExplainer(section.id),
              }}
              onToggle={() => toggleSection(section.id)}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      )}

      {slots?.footer !== undefined && (
        <div
          className={`shrink-0 ${awaitingInputCount > 0 || footerSections.length > 0 ? '' : 'mt-auto'}`}
        >
          {slots.footer}
        </div>
      )}

      <div
        className={`flex shrink-0 items-center gap-2.5 border-t border-border px-3.5 py-3 ${awaitingInputCount > 0 || footerSections.length > 0 || slots?.footer !== undefined ? '' : 'mt-auto'} ${collapsed ? 'justify-center' : ''}`}
      >
        {runningCount > 0 ? (
          <span className="flex items-center gap-1.5 font-mono text-3xs-plus text-warning">
            <StatusDot colorClass="bg-warning" pulse />
            {!collapsed && `${runningCount} running`}
          </span>
        ) : (
          !collapsed && (
            <span className="font-mono text-2xs text-muted-foreground">{version}</span>
          )
        )}
        <a
          href="https://github.com/noctcore/nightcore"
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
          title="View on GitHub"
          className={`flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground ${collapsed ? '' : 'ml-auto'}`}
        >
          <GithubIcon size={16} />
        </a>
      </div>

      {/* T11 "update available": the bottom-most strip, below the version row, so it
          never disturbs the footer's mt-auto push chain. Rendered only when the
          startup probe found a newer version (`slots.updatePill` is otherwise null). */}
      {slots?.updatePill}
    </aside>
  );
}
