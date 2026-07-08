/** The Settings card model: the per-page card/row config `SettingsView` renders,
 *  plus the model/effort adapters the run-shaping controls need. Split out of
 *  `SettingsView.tsx` to keep the view a thin shell. The adapters build on the
 *  canonical `@/lib/models` source (the same one the per-task picker uses), so
 *  Settings never re-derives its own model/effort vocabulary. */
import {
  AgentsIcon,
  BellIcon,
  BoltIcon,
  BranchIcon,
  FieldValue,
  FolderIcon,
  GearIcon,
  LayersIcon,
  LIVE_MODEL_CATALOG_DATA,
  LockIcon,
  ModelSelect,
  NumberField,
  resolveProviderForModel,
  Segmented,
  SparkIcon,
  Toggle,
  useModelCatalog,
} from '@/components/ui';
import {
  type AppInfo,
  PROVIDER_LABEL,
  type Settings,
  type SettingsPatch,
} from '@/lib/bridge';
import {
  effortOptionsForModel,
  isEffortSupported,
  MODEL_OPTIONS,
  modelOptionFor,
} from '@/lib/models';

import { buildAboutCards } from './settings-about-cards';
import { buildInterfaceCards } from './settings-interface-cards';
import type { SettingsCardProps } from './SettingsCard';
import type { EffectiveSettings } from './SettingsView/SettingsView.hooks';
import type { SettingsPage } from './SettingsView/SettingsView.types';

// The Settings model/effort options reuse the SAME canonical source as the
// per-task picker (`MODEL_OPTIONS`/`EFFORT_OPTIONS`) so the persisted value is an
// SDK long id (e.g. `claude-opus-4-8`) — the single source of truth for model ids.
// The picker label stays friendly; the stored/sent value is the SDK id.
const MODELS: [value: string, label: string][] = MODEL_OPTIONS.map((m) => [
  m.id,
  m.label.split(' ')[0] ?? m.label,
]);

/** The effort levels to offer in Settings, model-aware: the default model decides
 *  which levels apply (the premium tier unlocks the higher levels). The `none`
 *  sentinel is a per-task affordance, not a global default, so it is excluded. */
function effortChoices(model: string): [value: string, label: string][] {
  return effortOptionsForModel(model)
    .filter((e) => e.id !== 'none')
    .map((e) => [e.id, e.label]);
}

/** The highest effort level a model offers — the clamp target when the default
 *  model changes to one that can't honor the currently-stored effort. */
function highestEffortFor(model: string): string {
  const choices = effortChoices(model);
  return choices.at(-1)?.[0] ?? 'high';
}
/** Selectable max-concurrency values as `[value, label]` pairs. */
const CONCURRENCY: [value: string, label: string][] = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['6', '6'],
];
/** Selectable permission modes as `[value, label]` pairs. */
const PERMISSION_MODES: [value: string, label: string][] = [
  ['auto-accept', 'Auto'],
  ['plan', 'Plan'],
  ['ask', 'Ask'],
];
/** Selectable default run modes as `[value, label]` pairs. */
const RUN_MODES: [value: string, label: string][] = [
  ['main', 'Main'],
  ['worktree', 'Worktree'],
];

/** Which model option a stored value selects. Settings persist SDK long ids that
 *  match `MODEL_OPTIONS` directly; a legacy short id (`opus-4.8`) is matched by
 *  family so the segmented control highlights the right chip. Falls back to the
 *  raw value when unrecognized. */
function resolveModelValue(model: string): string {
  return modelOptionFor(model)?.id ?? model;
}

/** The default-model control. With a single provider (today) a compact `Segmented`
 *  row is clearest; once the live catalog reports >1 provider it adopts the
 *  provider-grouped `ModelSelect` combobox, which scales past a wide chip row (B5).
 *  The default effort is a separate Settings row, so the combobox hides its own.
 *  Item 6 (B5): Settings keeps NO per-selection provider stamp — the default
 *  model's provider is the authoritative global `settings.provider`, not a
 *  Task-style `providerId` (needed only where a pick has no provider context). */
function DefaultModelControl({ value, onPick }: { value: string; onPick: (m: string) => void }) {
  const catalog = useModelCatalog(LIVE_MODEL_CATALOG_DATA);
  const providers =
    catalog.status === 'ready'
      ? new Set(catalog.models.map((m) => resolveProviderForModel(m.value) ?? 'other')).size
      : 1;
  if (providers > 1) {
    return (
      <ModelSelect
        ariaLabel="Default model"
        showEffort={false}
        catalog={catalog}
        value={{ model: value, effort: null }}
        // Ignore the synthetic null row (no "Inherit" default) and drop
        // `sel.providerId` on purpose — `settings.provider` owns the default
        // model's provider (see the doc-comment above). Item 6 (B5).
        onChange={(sel) => sel.model !== null && onPick(sel.model)}
      />
    );
  }
  return <Segmented options={MODELS} value={resolveModelValue(value)} onChange={onPick} />;
}

/** The data and patch callbacks `buildCards` needs to assemble each page's cards. */
export interface CardContext {
  effective: EffectiveSettings;
  settings: Settings;
  patchScoped: (patch: SettingsPatch) => void;
  patchGlobal: (patch: SettingsPatch) => void;
  activeProjectPath: string | null;
  appInfo: AppInfo | null;
}

/** Build the card set for a settings page. The run-shaping controls (model,
 *  effort, concurrency, permission mode) are live; everything else is
 *  presentational (a not-yet-built page or a light scaffold). */
export function buildCards(page: SettingsPage, ctx: CardContext): SettingsCardProps[] {
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
                <DefaultModelControl
                  value={effective.defaultModel}
                  onPick={(v) =>
                    patchScoped(
                      // Reconcile the stored effort when the new model can't honor
                      // it (e.g. a premium-only level after switching to Haiku).
                      isEffortSupported(v, effective.defaultEffort)
                        ? { defaultModel: v }
                        : { defaultModel: v, defaultEffort: highestEffortFor(v) },
                    )
                  }
                />
              ),
            },
            {
              label: 'Reasoning effort',
              hint: 'Thinking budget per turn',
              control: (
                <Segmented
                  options={effortChoices(effective.defaultModel)}
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
            {
              label: 'Sandbox agent writes (macOS, experimental)',
              hint: 'Block file writes outside the task workspace at the OS layer',
              control: (
                // Global-only (like Delete-on-merge): OS containment is a
                // machine-level guarantee, not a per-project preference.
                <Toggle
                  on={settings.sandboxSessions}
                  onChange={(next) => patchGlobal({ sandboxSessions: next })}
                  label="Sandbox agent writes (macOS, experimental)"
                />
              ),
            },
          ],
        },
      ];
    case 'constitution':
      // The Constitution editor is fully interactive (load/edit/save + regenerate),
      // so it renders outside the presentational `SettingsCard` set — like the MCP
      // servers card. No presentational rows here.
      return [];
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
              label: 'Delete on merge',
              hint: 'Remove the worktree (and its branch) after the task is merged',
              control: (
                <Toggle
                  on={settings.cleanupWorktrees}
                  onChange={(next) => patchGlobal({ cleanupWorktrees: next })}
                  label="Delete worktree on merge"
                />
              ),
            },
          ],
        },
      ];
    case 'interface':
      return buildInterfaceCards(settings, patchGlobal);
    case 'providers':
      return [
        {
          icon: <BoltIcon size={18} />,
          title: PROVIDER_LABEL,
          subtitle: 'Local CLI authentication for running agents.',
          rows: [
            {
              label: 'Status',
              hint: `Authenticated via the local ${PROVIDER_LABEL} CLI`,
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
    case 'about':
      return buildAboutCards(appInfo);
  }
}
