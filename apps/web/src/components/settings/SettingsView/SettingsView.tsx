import type { ReactNode } from 'react';
import {
  AgentsIcon,
  BellIcon,
  BookIcon,
  BoltIcon,
  BrandMark,
  BranchIcon,
  FolderIcon,
  GearIcon,
  GithubIcon,
  IconTile,
  LayersIcon,
  LockIcon,
  SlidersIcon,
  SparkIcon,
} from '@/components/ui';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@/lib/models';
import { parseNumericCommit } from '@/lib/numeric-field';
import { McpServersCard } from '../McpServersCard';
import { SettingsCard } from '../SettingsCard';
import type { SettingsCardProps } from '../SettingsCard';
import { useAppInfo, useSettingsView, type EffectiveSettings } from './SettingsView.hooks';
import type {
  SettingsPage,
  SettingsScope,
  SettingsViewProps,
} from './SettingsView.types';

// The Settings model/effort options reuse the SAME canonical source as the
// per-task picker (`MODEL_OPTIONS`/`EFFORT_OPTIONS`) so the persisted value is an
// SDK long id (e.g. `claude-opus-4-8`) — the single source of truth for model ids
// (P0). The picker label stays friendly; the stored/sent value is the SDK id.
const MODELS: [value: string, label: string][] = MODEL_OPTIONS.map((m) => [
  m.id,
  m.label.split(' ')[0] ?? m.label,
]);
const EFFORTS: [value: string, label: string][] = EFFORT_OPTIONS.filter(
  (e) => e.id !== 'none',
).map((e) => [e.id, e.label]);
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
const RUN_MODES: [value: string, label: string][] = [
  ['main', 'Main'],
  ['worktree', 'Worktree'],
];

/** Which model option a stored value selects. Settings persist SDK long ids that
 *  match `MODEL_OPTIONS` directly; a legacy short id (`opus-4.8`) is matched by
 *  family so the segmented control highlights the right chip. Falls back to the
 *  raw value when unrecognized. */
function resolveModelValue(model: string): string {
  if (MODELS.some(([v]) => v === model)) return model;
  const family = model.toLowerCase();
  const match = MODEL_OPTIONS.find((o) => {
    const f = o.label.toLowerCase().split(' ')[0] ?? '';
    return f.length > 0 && family.includes(f);
  });
  return match?.id ?? model;
}

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

/** An editable switch toggle bound to a persisted boolean setting. */
function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`inline-flex h-[18px] w-[32px] items-center rounded-full px-0.5 transition-colors ${on ? 'bg-primary' : 'bg-white/[0.12]'}`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </button>
  );
}

/** A numeric input bound to an optional ceiling setting (SDK guardrails). Empty
 *  ⇒ the field inherits (the placeholder shows the inherited/default value). A
 *  committed value is sent via `onCommit`; an empty/blank or unchanged value is a
 *  no-op (the Rust side cannot clear an `Option` ceiling back to inherit, so the
 *  control only ever SETS a value — matching the model/effort override contract). */
function NumberField({
  value,
  placeholder,
  onCommit,
  step,
  min,
  ariaLabel,
  prefix,
}: {
  value: number | null;
  placeholder: string;
  onCommit: (next: number) => void;
  step?: string;
  min?: number;
  ariaLabel: string;
  prefix?: string;
}): ReactNode {
  const commit = (raw: string) => {
    const parsed = parseNumericCommit(raw, value, min ?? 0);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-black/20 px-2.5 py-1.5 focus-within:border-primary">
      {prefix !== undefined && (
        <span className="font-mono text-[12px] text-muted-foreground">{prefix}</span>
      )}
      <input
        type="number"
        inputMode="numeric"
        step={step}
        min={min}
        aria-label={ariaLabel}
        defaultValue={value ?? ''}
        key={value ?? 'empty'}
        placeholder={placeholder}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-[88px] bg-transparent text-right font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
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

function RepoLink({ href }: { href: string }): ReactNode {
  return (
    <a
      href={href}
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
      { page: 'worktrees', label: 'Git worktrees', icon: <BranchIcon size={16} /> },
    ],
  },
  {
    label: 'INTEGRATIONS',
    items: [
      { page: 'providers', label: 'Providers', icon: <BoltIcon size={16} /> },
      { page: 'hooks', label: 'Hooks & notifications', icon: <BellIcon size={16} /> },
    ],
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
  worktrees: { title: 'Git worktrees', subtitle: 'ISOLATION', icon: <BranchIcon size={24} /> },
  providers: { title: 'Providers', subtitle: 'MODEL BACKENDS', icon: <BoltIcon size={24} /> },
  hooks: { title: 'Hooks & notifications', subtitle: 'EVENTS', icon: <BellIcon size={24} /> },
  paths: { title: 'Paths', subtitle: 'STORAGE', icon: <FolderIcon size={24} /> },
  about: { title: 'About', subtitle: 'NIGHTCORE', icon: <BrandMark size={36} /> },
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
    patchGlobal,
  } = useSettingsView({ settings, activeProjectId, onUpdate });

  const appInfo = useAppInfo();
  const header = PAGE_HEADERS[page];
  const cards = buildCards(page, {
    effective,
    settings,
    patchScoped,
    patchGlobal,
    activeProjectPath,
    appInfo,
  });
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

          {/* The MCP servers card lives on the Providers page. It is fully
              interactive (its own editor modal + remove confirm), so it renders
              outside the presentational `SettingsCard` set. Edits route through the
              SAME scoped patch as every other control (global, or the active
              project's override per the scope tab). */}
          {page === 'providers' && (
            <McpServersCard
              servers={effective.mcpServers}
              onChange={(next) => patchScoped({ mcpServers: next })}
            />
          )}

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
  patchGlobal: (patch: Parameters<ReturnType<typeof useSettingsView>['patchGlobal']>[0]) => void;
  activeProjectPath: string | null;
  appInfo: import('@/lib/bridge').AppInfo | null;
}

/** Build the card set for a settings page. The four run-shaping controls (model,
 *  effort, concurrency, permission mode) are live; everything else is
 *  presentational (M2/M3 or a light scaffold). */
function buildCards(page: SettingsPage, ctx: CardContext): SettingsCardProps[] {
  const { effective, settings, patchScoped, patchGlobal, activeProjectPath, appInfo } = ctx;
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
                  value={resolveModelValue(effective.defaultModel)}
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
          subtitle: 'How many agents run at the same time. Resizes the live pool.',
          rows: [
            {
              label: 'Max concurrency',
              hint: 'Parallel agent runs',
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
        {
          icon: <GearIcon size={18} />,
          title: 'Limits',
          subtitle: 'Autonomy ceilings new tasks inherit. A per-task override always wins.',
          rows: [
            {
              label: 'Max turns',
              hint: 'Conversation turns before a run stops (empty = default 200)',
              control: (
                <NumberField
                  value={effective.maxTurns}
                  placeholder="200"
                  min={1}
                  step="1"
                  ariaLabel="Max turns"
                  onCommit={(n) => patchScoped({ maxTurns: n })}
                />
              ),
            },
            {
              label: 'Max budget',
              hint: 'Hard cost ceiling per run in USD (empty = uncapped)',
              control: (
                <NumberField
                  value={effective.maxBudgetUsd}
                  placeholder="uncapped"
                  min={0}
                  step="0.5"
                  prefix="$"
                  ariaLabel="Max budget in USD"
                  onCommit={(n) => patchScoped({ maxBudgetUsd: n })}
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
          ],
        },
      ];
    case 'worktrees':
      return [
        {
          icon: <BranchIcon size={18} />,
          title: 'Worktree isolation',
          subtitle: 'Where new tasks run, and whether their worktree is cleaned up.',
          rows: [
            {
              label: 'Default run mode',
              hint: 'Main runs in the project root; Worktree isolates on a branch',
              control: (
                <Segmented
                  options={RUN_MODES}
                  value={effective.defaultRunMode}
                  onChange={(v) =>
                    patchScoped({ defaultRunMode: v as typeof effective.defaultRunMode })
                  }
                />
              ),
            },
            {
              label: 'Delete on complete',
              hint: 'Remove the worktree after a task is merged',
              control: (
                <Toggle
                  on={settings.cleanupWorktrees}
                  onChange={(next) => patchGlobal({ cleanupWorktrees: next })}
                  label="Delete worktree on complete"
                />
              ),
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
          subtitle: 'A desktop notification when a task finishes or fails.',
          rows: [
            {
              label: 'Native notifications',
              hint: 'Notify on Done and Failed',
              control: (
                <Toggle
                  on={settings.notifyOnComplete}
                  onChange={(next) => patchGlobal({ notifyOnComplete: next })}
                  label="Native notifications on task complete"
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
    case 'about': {
      const version = appInfo?.version ?? '—';
      const repo = appInfo?.repository ?? 'https://github.com/Shironex/nightcore';
      const repoLabel = repo.replace(/^https?:\/\//, '');
      return [
        {
          icon: <BookIcon size={18} />,
          title: 'Nightcore',
          subtitle: 'Autonomous Claude dev studio — a rewrite of AutoMaker.',
          rows: [
            { label: 'Version', control: <Pill>v{version}</Pill> },
            { label: 'Repository', hint: repoLabel, control: <RepoLink href={repo} /> },
          ],
        },
      ];
    }
  }
}
