import type { ReactNode } from 'react';
import {
  AgentsIcon,
  BellIcon,
  BoardIcon,
  BookIcon,
  BoltIcon,
  BrandMark,
  BranchIcon,
  FolderIcon,
  GithubIcon,
  IconTile,
  LayersIcon,
  LockIcon,
  SlidersIcon,
  SparkIcon,
} from '@/components/ui';
import { SettingsCard } from '../SettingsCard';
import type { SettingsCardProps } from '../SettingsCard';
import { useSettingsView, type EffectiveSettings } from './SettingsView.hooks';
import type {
  SettingsPage,
  SettingsScope,
  SettingsViewProps,
} from './SettingsView.types';

const MODELS: [value: string, label: string][] = [
  ['opus-4.8', 'Opus'],
  ['sonnet-4.8', 'Sonnet'],
  ['haiku-4.5', 'Haiku'],
];
const EFFORTS: [value: string, label: string][] = [
  ['low', 'Low'],
  ['medium', 'Med'],
  ['high', 'High'],
];
const CONCURRENCY: [value: string, label: string][] = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['6', '6'],
];
const PERMISSION_MODES: [value: string, label: string][] = [
  ['auto-accept', 'Auto'],
  ['plan', 'Plan'],
  ['ask', 'Ask'],
];

/** A segmented selector. `disabled` renders it visible-but-inert (roadmap). */
function Segmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: [value: string, label: string][];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <div
      className={`inline-flex rounded-lg border border-border bg-black/20 p-0.5 ${disabled ? 'opacity-40' : ''}`}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
            v === value
              ? 'bg-primary/[0.18] text-primary'
              : 'text-muted-foreground enabled:hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A read-only toggle for roadmap affordances — shows persisted state, inert. */
function RoadmapToggle({ on }: { on: boolean }): ReactNode {
  return (
    <span
      aria-hidden
      className={`inline-flex h-[18px] w-[32px] items-center rounded-full px-0.5 opacity-40 ${on ? 'bg-primary' : 'bg-white/[0.12]'}`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </span>
  );
}

/** A read-only mono value pill (paths, versions, fixed values). */
function Pill({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/** A read-only mono field — the presentational stand-in for M2/M3 text inputs. */
function FieldValue({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="block w-full rounded-lg border border-border bg-black/20 px-3 py-2.5 font-mono text-[12.5px] text-foreground">
      {children}
    </span>
  );
}

function Swatches(): ReactNode {
  const swatches: [name: string, color: string][] = [
    ['Cosmic', 'oklch(78% .22 290)'],
    ['Plum', 'oklch(74% .15 355)'],
    ['Void', 'oklch(72% .28 295)'],
    ['Ember', 'oklch(70% .19 40)'],
  ];
  return (
    <span className="flex gap-1.5">
      {swatches.map(([name, color], i) => (
        <span
          key={name}
          title={name}
          className="h-6 w-6 rounded-[7px]"
          style={{
            background: color,
            boxShadow:
              i === 0 ? '0 0 0 2px var(--nc-card), 0 0 0 4px var(--nc-primary)' : undefined,
          }}
        />
      ))}
    </span>
  );
}

function RepoLink(): ReactNode {
  return (
    <a
      href="https://github.com"
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-[12.5px] font-semibold text-primary"
    >
      <GithubIcon size={15} />
      Open repo
    </a>
  );
}

const SCOPE_TABS: [value: SettingsScope, label: string][] = [
  ['global', 'Global'],
  ['project', 'This project'],
];

interface NavItem {
  page: SettingsPage;
  label: string;
  icon: ReactNode;
  badge?: string;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'AGENTS',
    items: [
      { page: 'models', label: 'Models & runs', icon: <SlidersIcon size={16} /> },
      { page: 'permissions', label: 'Permissions', icon: <LockIcon size={16} />, badge: 'M3' },
    ],
  },
  {
    label: 'WORKTREES',
    items: [
      { page: 'worktrees', label: 'Git worktrees', icon: <BranchIcon size={16} />, badge: 'M2' },
    ],
  },
  {
    label: 'INTEGRATIONS',
    items: [
      { page: 'providers', label: 'Providers', icon: <BoltIcon size={16} /> },
      { page: 'hooks', label: 'Hooks & notifications', icon: <BellIcon size={16} />, badge: 'M3' },
    ],
  },
  {
    label: 'APPEARANCE',
    items: [{ page: 'appearance', label: 'Theme & density', icon: <LayersIcon size={16} /> }],
  },
  {
    label: 'SYSTEM',
    items: [
      { page: 'paths', label: 'Paths', icon: <FolderIcon size={16} /> },
      { page: 'about', label: 'About', icon: <BookIcon size={16} /> },
    ],
  },
];

interface PageHeader {
  title: string;
  subtitle: string;
  icon: ReactNode;
  badge?: string;
}

const PAGE_HEADERS: Record<SettingsPage, PageHeader> = {
  models: { title: 'Models & runs', subtitle: 'AGENT DEFAULTS', icon: <SlidersIcon size={26} /> },
  permissions: { title: 'Permissions', subtitle: 'TOOL ACCESS', icon: <LockIcon size={24} />, badge: 'M3' },
  worktrees: { title: 'Git worktrees', subtitle: 'ISOLATION', icon: <BranchIcon size={24} />, badge: 'M2' },
  providers: { title: 'Providers', subtitle: 'MODEL BACKENDS', icon: <BoltIcon size={24} /> },
  hooks: { title: 'Hooks & notifications', subtitle: 'EVENTS', icon: <BellIcon size={24} />, badge: 'M3' },
  appearance: { title: 'Appearance', subtitle: 'THEME & LAYOUT', icon: <LayersIcon size={24} /> },
  paths: { title: 'Paths', subtitle: 'STORAGE', icon: <FolderIcon size={24} /> },
  about: { title: 'About', subtitle: 'NIGHTCORE v0.1.0', icon: <BrandMark size={36} /> },
};

const PAGE_NOTES: Partial<Record<SettingsPage, string>> = {
  models: 'Changes apply to new runs. Active agents keep their current model.',
  about: 'Some changes require restarting the app. Your tasks and history are safe.',
};

/** The Settings surface: a grouped left nav, a page header with a scope toggle,
 *  and icon-tile cards per page. The four run-shaping controls persist (global
 *  or per-project per the scope tab); the M2/M3 pages are presentational and
 *  roadmap-badged. */
export function SettingsView({
  settings,
  activeProjectId,
  activeProjectName,
  activeProjectPath = null,
  onUpdate,
}: SettingsViewProps) {
  const {
    page,
    setPage,
    scope,
    setScope,
    projectScopeEnabled,
    effective,
    patchScoped,
  } = useSettingsView({ settings, activeProjectId, onUpdate });

  const header = PAGE_HEADERS[page];
  const cards = buildCards(page, { effective, settings, patchScoped, activeProjectPath });
  const note = PAGE_NOTES[page];

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-[238px] shrink-0 overflow-y-auto border-r border-border bg-black/[0.14] px-3 py-5">
        <div className="px-2 pb-3 text-lg font-semibold tracking-tight">Settings</div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
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
                <span className="flex-1 text-[13px]">{item.label}</span>
                {item.badge !== undefined && (
                  <span className="rounded bg-primary/[0.18] px-1 py-px font-mono text-[8px] tracking-[0.04em] text-primary">
                    {item.badge}
                  </span>
                )}
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
                {header.badge !== undefined && (
                  <span className="rounded bg-primary/[0.18] px-1.5 py-px font-mono text-[8.5px] text-primary">
                    {header.badge}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
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
                    className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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

          {note !== undefined && (
            <div className="mt-2 flex items-center gap-2.5 rounded-2xl border border-border bg-white/[0.02] px-[18px] py-3.5">
              <SparkIcon size={16} className="text-warning" />
              <span className="text-[12.5px] text-muted-foreground">
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

interface CardContext {
  effective: EffectiveSettings;
  settings: SettingsViewProps['settings'];
  patchScoped: (patch: Parameters<ReturnType<typeof useSettingsView>['patchScoped']>[0]) => void;
  activeProjectPath: string | null;
}

/** Build the card set for a settings page. The four run-shaping controls (model,
 *  effort, concurrency, permission mode) are live; everything else is
 *  presentational (M2/M3 or a light scaffold). */
function buildCards(page: SettingsPage, ctx: CardContext): SettingsCardProps[] {
  const { effective, settings, patchScoped, activeProjectPath } = ctx;
  switch (page) {
    case 'models':
      return [
        {
          icon: <SparkIcon size={18} />,
          title: 'Model & reasoning',
          subtitle: 'Applied to newly created tasks unless overridden per-task.',
          rows: [
            {
              label: 'Default model',
              hint: 'Used for new tasks',
              control: (
                <Segmented
                  options={MODELS}
                  value={effective.defaultModel}
                  onChange={(v) => patchScoped({ defaultModel: v })}
                />
              ),
            },
            {
              label: 'Reasoning effort',
              hint: 'Thinking budget per turn',
              control: (
                <Segmented
                  options={EFFORTS}
                  value={effective.defaultEffort}
                  onChange={(v) => patchScoped({ defaultEffort: v })}
                />
              ),
            },
          ],
        },
        {
          icon: <AgentsIcon size={18} />,
          title: 'Parallelism',
          subtitle: 'How many agents run at the same time. Enforcement lands in M2.',
          badge: 'M2',
          rows: [
            {
              label: 'Max concurrency',
              hint: 'Parallel agent runs (persists; not yet enforced)',
              control: (
                <Segmented
                  options={CONCURRENCY}
                  value={String(effective.maxConcurrency)}
                  onChange={(v) => patchScoped({ maxConcurrency: Number(v) })}
                />
              ),
            },
          ],
        },
      ];
    case 'permissions':
      return [
        {
          icon: <LockIcon size={18} />,
          title: 'Tool permissions',
          subtitle: 'How the agent is allowed to act during a run.',
          rows: [
            {
              label: 'Permission mode',
              hint: 'auto-accept · plan · ask (persists; runtime still auto-denies)',
              control: (
                <Segmented
                  options={PERMISSION_MODES}
                  value={effective.permissionMode}
                  onChange={(v) => patchScoped({ permissionMode: v })}
                />
              ),
            },
            {
              label: 'Interactive approval',
              hint: 'Approve or deny tool use from the logs panel (today it auto-denies).',
              control: <RoadmapToggle on={false} />,
            },
          ],
        },
      ];
    case 'worktrees':
      return [
        {
          icon: <BranchIcon size={18} />,
          title: 'Worktree isolation',
          subtitle: 'Each running task gets its own branch and worktree.',
          badge: 'M2',
          rows: [
            { label: 'Worktree base directory', control: <FieldValue>.nightcore/worktrees</FieldValue> },
            {
              label: 'Files to copy into each worktree',
              hint: 'Comma-separated globs',
              control: <FieldValue>.env, .env.local</FieldValue>,
            },
            {
              label: 'Delete on complete',
              hint: 'Remove the worktree after a task is merged',
              control: <RoadmapToggle on={settings.cleanupWorktrees} />,
            },
          ],
        },
      ];
    case 'providers':
      return [
        {
          icon: <BoltIcon size={18} />,
          title: 'Claude',
          subtitle: 'Local CLI authentication for running agents.',
          rows: [
            {
              label: 'Status',
              hint: 'Authenticated via the local Claude CLI',
              control: (
                <span className="flex items-center gap-2 text-[12.5px] font-semibold text-success">
                  <span className="h-[7px] w-[7px] rounded-full bg-success" />
                  Active
                </span>
              ),
            },
          ],
        },
        {
          icon: <LayersIcon size={18} />,
          title: 'Other providers',
          subtitle: 'The provider seam where Codex and others slot in.',
          badge: 'later',
          rows: [
            {
              label: 'Codex',
              hint: 'Not yet available',
              control: <span className="text-[12.5px] text-muted-foreground">Coming soon</span>,
            },
          ],
        },
      ];
    case 'hooks':
      return [
        {
          icon: <BellIcon size={18} />,
          title: 'Notifications',
          subtitle: 'React to task_success, task_failed and auto_mode_complete.',
          badge: 'M3',
          rows: [
            {
              label: 'Native notifications',
              control: <RoadmapToggle on={settings.notifyOnComplete} />,
            },
            {
              label: 'Webhook URL',
              hint: 'POST a JSON payload on each event',
              control: <FieldValue>https://</FieldValue>,
            },
          ],
        },
      ];
    case 'appearance':
      return [
        {
          icon: <LayersIcon size={18} />,
          title: 'Theme',
          subtitle: 'Accent and surface palette.',
          rows: [
            { label: 'Accent', hint: 'Cosmic violet is active', control: <Swatches /> },
            { label: 'Mode', control: <Pill>Dark</Pill> },
          ],
        },
        {
          icon: <BoardIcon size={18} />,
          title: 'Density',
          subtitle: 'Spacing across boards and cards.',
          badge: 'M2',
          rows: [
            {
              label: 'Card density',
              hint: 'Affects the Kanban board',
              control: (
                <Segmented
                  options={[
                    ['comfortable', 'Comfortable'],
                    ['compact', 'Compact'],
                  ]}
                  value="comfortable"
                  onChange={() => {}}
                  disabled
                />
              ),
            },
          ],
        },
      ];
    case 'paths':
      return [
        {
          icon: <FolderIcon size={18} />,
          title: 'Locations',
          subtitle: 'Where Nightcore stores its data.',
          rows: [
            { label: 'Data directory', control: <FieldValue>~/.nightcore</FieldValue> },
            {
              label: 'Project config',
              hint: 'Per-repo .nightcore/ folder',
              control: (
                <FieldValue>{`${activeProjectPath ?? '~/dev/nightcore'}/.nightcore`}</FieldValue>
              ),
            },
          ],
        },
      ];
    case 'about':
      return [
        {
          icon: <BookIcon size={18} />,
          title: 'Nightcore',
          subtitle: 'Autonomous Claude dev studio — a rewrite of AutoMaker.',
          rows: [
            { label: 'Version', control: <Pill>v0.1.0</Pill> },
            { label: 'Build', control: <Pill>0042</Pill> },
            { label: 'Repository', hint: 'github.com/you/nightcore', control: <RepoLink /> },
          ],
        },
      ];
  }
}
