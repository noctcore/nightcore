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
  LockIcon,
  NumberField,
  Segmented,
  SparkIcon,
  Toggle,
} from '@/components/ui';
import {
  type AppInfo,
  type DetectedEditor,
  PROVIDER_LABEL,
  type Settings,
  type SettingsPatch,
} from '@/lib/bridge';
import {
  isEffortSupported,
} from '@/lib/models';

import { buildAboutCards } from './settings-about-cards';
import { buildGithubCards } from './settings-github-cards';
import { buildInterfaceCards } from './settings-interface-cards';
import {
  DefaultModelControl,
  defaultModelForProvider,
  effortChoices,
  highestEffortFor,
  PROVIDERS,
} from './settings-run-controls';
import type { SettingsCardProps } from './SettingsCard';
import type { EffectiveSettings } from './SettingsView/SettingsView.hooks';
import type { SettingsPage } from './SettingsView/SettingsView.types';
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

/** The editor-picker options: an "Auto" sentinel (empty value ⇒ Rust auto-detects
 *  the first installed editor) followed by each detected editor. */
function editorOptions(editors: DetectedEditor[]): [value: string, label: string][] {
  return [['', 'Auto'], ...editors.map((e): [string, string] => [e.id, e.label])];
}


/** The data and patch callbacks `buildCards` needs to assemble each page's cards. */
export interface CardContext {
  effective: EffectiveSettings;
  settings: Settings;
  patchScoped: (patch: SettingsPatch) => void;
  patchGlobal: (patch: SettingsPatch) => void;
  activeProjectPath: string | null;
  appInfo: AppInfo | null;
  onRestartOnboarding: () => void;
  isAppIdle: boolean;
  /** Editors detected on this machine, for the worktree open-in-editor picker. */
  editors: DetectedEditor[];
}

/** Build the card set for a settings page. The run-shaping controls (model,
 *  effort, concurrency, permission mode) are live; everything else is
 *  presentational (a not-yet-built page or a light scaffold). */
export function buildCards(page: SettingsPage, ctx: CardContext): SettingsCardProps[] {
  const {
    effective,
    settings,
    patchScoped,
    patchGlobal,
    activeProjectPath,
    appInfo,
    onRestartOnboarding,
    editors,
  } = ctx;
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
                  provider={settings.provider}
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
            {
              label: 'Open in editor',
              hint:
                editors.length > 0
                  ? 'Editor the worktree row "Open in editor" button launches'
                  : 'No supported editor detected on PATH — install one (Cursor, VS Code, …)',
              control: (
                <Segmented
                  // Empty string is the "Auto" sentinel: the Rust side auto-detects
                  // the first installed editor. Detected editors follow. Global-only —
                  // it's a machine/user preference, not a per-project setting.
                  options={editorOptions(editors)}
                  value={settings.preferredEditor ?? ''}
                  onChange={(v) => patchGlobal({ preferredEditor: v })}
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
          title: 'Default provider',
          subtitle: 'Choose what new tasks inherit when they do not pick a model.',
          rows: [
            {
              label: 'Provider',
              hint: 'Task-level model picks can use either provider',
              control: (
                <Segmented
                  options={PROVIDERS}
                  value={settings.provider}
                  onChange={(provider) => {
                    const defaultModel = defaultModelForProvider(provider);
                    patchGlobal(
                      isEffortSupported(defaultModel, settings.defaultEffort)
                        ? { provider, defaultModel }
                        : {
                            provider,
                            defaultModel,
                            defaultEffort: highestEffortFor(defaultModel),
                          },
                    );
                  }}
                />
              ),
            },
            {
              label: 'Current selection',
              hint:
                settings.provider === 'codex'
                  ? 'Uses CODEX_API_KEY or your local Codex login'
                  : `Authenticated via the local ${PROVIDER_LABEL} CLI`,
              control: (
                <span className="flex items-center gap-2 text-[12.5px] font-semibold text-success">
                  <span className="h-[7px] w-[7px] rounded-full bg-success" />
                  {settings.provider === 'codex' ? 'Codex default' : 'Claude default'}
                </span>
              ),
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
            {
              label: 'Waiting for input',
              hint: 'Notify when a run parks on a question (on by default)',
              control: (
                <Toggle
                  on={settings.notifyOnAwaitingInput}
                  onChange={(next) => patchGlobal({ notifyOnAwaitingInput: next })}
                  label="Native notifications when a run awaits your input"
                />
              ),
            },
          ],
        },
        ...buildGithubCards(settings, patchGlobal),
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
      return buildAboutCards(appInfo, onRestartOnboarding, ctx.isAppIdle);
  }
}
