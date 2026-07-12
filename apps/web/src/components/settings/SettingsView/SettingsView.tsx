/** The Settings surface: grouped left nav, per-page cards, and a global/project scope toggle. */
import type { ReactNode } from 'react';

import {
  BellIcon,
  BoltIcon,
  BookIcon,
  BranchIcon,
  BrandMark,
  DesignIcon,
  FolderIcon,
  GithubIcon,
  IconTile,
  LayersIcon,
  LockIcon,
  PerfIcon,
  SlidersIcon,
  SparkIcon,
  TerminalIcon,
} from '@/components/ui';

import { ConstitutionCard } from '../ConstitutionCard';
import { McpServersCard } from '../McpServersCard';
import { buildCards } from '../settings-cards';
import { SettingsCard } from '../SettingsCard';
import { useAppInfo, useEditors, useSettingsView } from './SettingsView.hooks';
import type {
  SettingsPage,
  SettingsScope,
  SettingsViewProps,
} from './SettingsView.types';

/** The scope toggle tabs as `[value, label]` pairs. */
const SCOPE_TABS: [value: SettingsScope, label: string][] = [
  ['global', 'Global'],
  ['project', 'This project'],
];

/** A single entry in the left nav. */
interface NavItem {
  page: SettingsPage;
  label: string;
  icon: ReactNode;
}
/** A labelled group of nav entries. */
interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The left-nav structure: groups of pages with icons and optional badges. */
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'AGENTS',
    items: [
      { page: 'models', label: 'Models & runs', icon: <SlidersIcon size={16} /> },
      { page: 'permissions', label: 'Permissions', icon: <LockIcon size={16} /> },
      { page: 'constitution', label: 'Constitution', icon: <BookIcon size={16} /> },
    ],
  },
  {
    label: 'AUTOMATION',
    items: [
      { page: 'automode', label: 'Auto Mode', icon: <BoltIcon size={16} /> },
      { page: 'usage', label: 'Usage', icon: <PerfIcon size={16} /> },
    ],
  },
  {
    label: 'WORKTREES',
    items: [
      { page: 'worktrees', label: 'Git worktrees', icon: <BranchIcon size={16} /> },
    ],
  },
  {
    label: 'INTEGRATIONS',
    items: [
      { page: 'providers', label: 'Providers', icon: <BoltIcon size={16} /> },
      { page: 'mcp', label: 'MCP Servers', icon: <LayersIcon size={16} /> },
      { page: 'notifications', label: 'Notifications', icon: <BellIcon size={16} /> },
      { page: 'github', label: 'GitHub', icon: <GithubIcon size={16} /> },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { page: 'interface', label: 'Interface', icon: <DesignIcon size={16} /> },
      { page: 'terminal', label: 'Terminal', icon: <TerminalIcon size={16} /> },
      { page: 'paths', label: 'Paths', icon: <FolderIcon size={16} /> },
      { page: 'about', label: 'About', icon: <BookIcon size={16} /> },
    ],
  },
];

/** The header (title, subtitle, icon, optional badge) shown atop each page. */
interface PageHeader {
  title: string;
  subtitle: string;
  icon: ReactNode;
}

/** The header content per settings page. */
const PAGE_HEADERS: Record<SettingsPage, PageHeader> = {
  models: { title: 'Models & runs', subtitle: 'AGENT DEFAULTS', icon: <SlidersIcon size={26} /> },
  permissions: { title: 'Permissions', subtitle: 'TOOL ACCESS', icon: <LockIcon size={24} /> },
  constitution: { title: 'Project Constitution', subtitle: 'PRE-FLIGHT CONTEXT', icon: <BookIcon size={24} /> },
  automode: { title: 'Auto Mode', subtitle: 'AUTONOMOUS LOOP', icon: <BoltIcon size={24} /> },
  usage: { title: 'Usage', subtitle: 'PROVIDER METERING', icon: <PerfIcon size={24} /> },
  worktrees: { title: 'Git worktrees', subtitle: 'ISOLATION', icon: <BranchIcon size={24} /> },
  providers: { title: 'Providers', subtitle: 'MODEL BACKENDS', icon: <BoltIcon size={24} /> },
  mcp: { title: 'MCP Servers', subtitle: 'EXTERNAL TOOLS', icon: <LayersIcon size={24} /> },
  notifications: { title: 'Notifications', subtitle: 'EVENTS', icon: <BellIcon size={24} /> },
  github: { title: 'GitHub', subtitle: 'ISSUE SYNC', icon: <GithubIcon size={24} /> },
  interface: { title: 'Interface', subtitle: 'LAYOUT', icon: <DesignIcon size={24} /> },
  terminal: { title: 'Terminal', subtitle: 'RENDERING', icon: <TerminalIcon size={24} /> },
  paths: { title: 'Paths', subtitle: 'STORAGE', icon: <FolderIcon size={24} /> },
  about: { title: 'About', subtitle: 'NIGHTCORE', icon: <BrandMark size={36} /> },
};

/** An optional footer note shown beneath the cards for certain pages. */
const PAGE_NOTES: Partial<Record<SettingsPage, string>> = {
  models: 'Changes apply to new runs. Active agents keep their current model.',
  about: 'Some changes require restarting the app. Your tasks and history are safe.',
};

/** The Settings surface: a grouped left nav, a page header with a scope toggle,
 *  and icon-tile cards per page. The run-shaping controls persist (global or
 *  per-project per the scope tab). */
export function SettingsView({
  settings,
  activeProjectId,
  activeProjectName,
  activeProjectPath = null,
  onUpdate,
  onRestartOnboarding,
  isAppIdle = true,
}: SettingsViewProps) {
  const {
    page,
    setPage,
    scope,
    setScope,
    projectScopeEnabled,
    effective,
    patchScoped,
    patchGlobal,
    usageMeter,
  } = useSettingsView({ settings, activeProjectId, onUpdate });

  const appInfo = useAppInfo();
  const editors = useEditors();
  const header = PAGE_HEADERS[page];
  const cards = buildCards(page, {
    effective,
    settings,
    patchScoped,
    patchGlobal,
    activeProjectPath,
    appInfo,
    onRestartOnboarding,
    isAppIdle,
    editors,
    onNavigate: setPage,
    usageMeter,
  });
  const note = PAGE_NOTES[page];

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-[238px] shrink-0 overflow-y-auto border-r border-border bg-black/[0.14] px-3 py-5">
        <div className="px-2 pb-3 text-lg font-semibold tracking-tight">Settings</div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-4xs-plus uppercase tracking-[0.18em] text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => setPage(item.page)}
                className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors ${
                  page === item.page
                    ? 'bg-primary/[0.12] font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
                }`}
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="flex-1 text-xs-plus2">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[800px] px-[38px] pb-[60px] pt-[30px]">
          <div className="mb-6 flex flex-wrap items-start gap-4">
            <IconTile size="lg">{header.icon}</IconTile>
            <div className="min-w-[200px] flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <h1 className="text-[25px] font-semibold tracking-tight">{header.title}</h1>
              </div>
              <div className="mt-1 font-mono text-3xs-plus uppercase tracking-[0.16em] text-muted-foreground">
                {header.subtitle}
              </div>
            </div>
            <div className="inline-flex shrink-0 rounded-lg border border-border bg-black/25 p-0.5">
              {SCOPE_TABS.map(([v, label]) => {
                const disabled = v === 'project' && !projectScopeEnabled;
                return (
                  <button
                    key={v}
                    type="button"
                    disabled={disabled}
                    onClick={() => setScope(v)}
                    title={disabled ? 'Activate a project to set per-project overrides' : undefined}
                    className={`rounded-md px-3 py-1 text-xs-flat font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      v === scope
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground enabled:hover:text-foreground'
                    }`}
                  >
                    {v === 'project' && activeProjectName !== null ? activeProjectName : label}
                  </button>
                );
              })}
            </div>
          </div>

          {cards.map((card, i) => (
            <SettingsCard key={`${card.title}-${i}`} {...card} />
          ))}

          {/* The MCP servers card lives on its own page. It is fully interactive
              (its own editor modal + remove confirm), so it renders outside the
              presentational `SettingsCard` set. Edits route through the SAME
              scoped patch as every other control (global, or the active
              project's override per the scope tab). */}
          {page === 'mcp' && (
            <McpServersCard
              servers={effective.mcpServers}
              onChange={(next) => patchScoped({ mcpServers: next })}
            />
          )}

          {/* The Constitution editor. The pack content is inherently per-project
              (one `context.md` per repo, edited via the bridge against the ACTIVE
              project); the on/off toggle follows the standard scope model (global or
              this project's override). */}
          {page === 'constitution' && (
            <ConstitutionCard
              enabled={effective.contextPackEnabled}
              onToggleEnabled={(next) => patchScoped({ contextPackEnabled: next })}
              projectActive={projectScopeEnabled}
            />
          )}

          {note !== undefined && (
            <div className="mt-2 flex items-center gap-2.5 rounded-2xl border border-border bg-white/[0.02] px-[18px] py-3.5">
              <SparkIcon size={16} className="text-warning" />
              <span className="text-xs-plus text-muted-foreground">
                {scope === 'project' && page === 'models'
                  ? 'These values override the global defaults for the active project only.'
                  : note}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
