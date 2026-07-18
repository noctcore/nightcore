/** The Settings card model: the per-page card/row config `SettingsView` renders,
 *  plus the model/effort adapters the run-shaping controls need. Split out of
 *  `SettingsView.tsx` to keep the view a thin shell. The adapters build on the
 *  canonical `@/lib/models` source (the same one the per-task picker uses), so
 *  Settings never re-derives its own model/effort vocabulary. */
import {
  AgentsIcon,
  BoltIcon,
  BranchIcon,
  FieldValue,
  FolderIcon,
  GearIcon,
  NumberField,
  Segmented,
  SparkIcon,
  StatusDot,
  Toggle,
} from '@/components/ui';
import {
  type AppInfo,
  type DetectedEditor,
  PROVIDER_LABEL,
  type ProviderCapabilities,
  type Settings,
  type SettingsPatch,
} from '@/lib/bridge';
import {
  isEffortSupported,
} from '@/lib/models';
import { runCeilingCaveatFor } from '@/lib/provider-capabilities';
import type { UsageMeterEnabledState } from '@/lib/useUsageMeterEnabled';

import { buildAboutCards } from './settings-about-cards';
import { buildAutoModeCards } from './settings-automode-cards';
import { buildGithubCards } from './settings-github-cards';
import { buildInterfaceCards } from './settings-interface-cards';
import { buildNotificationCards } from './settings-notification-cards';
import { buildPermissionsCards } from './settings-permissions-cards';
import {
  DefaultModelControl,
  defaultModelForProvider,
  effortChoices,
  highestEffortFor,
  PROVIDERS,
} from './settings-run-controls';
import { buildTerminalCards } from './settings-terminal-cards';
import { buildUsageCards } from './settings-usage-cards';
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
  /** Jump the left nav to another page (e.g. the Auto Mode → Permissions cross-link). */
  onNavigate: (page: SettingsPage) => void;
  /** The shared reactive usage-meter enabled signal (issue #305) the Usage page's
   *  toggle binds to. */
  usageMeter: UsageMeterEnabledState;
  /** The engine's DEFAULT provider's capability descriptor (issue #313), or `null`
   *  while it loads / outside Tauri. Backs the Limits card's run-ceiling caveat —
   *  a provider that can't enforce `maxTurns`/`maxBudgetUsd` (Codex) still shows
   *  those controls (they apply once a task resolves to a provider that DOES honor
   *  them), but the card notes they're silently ignored under the current default. */
  defaultProviderCapabilities: ProviderCapabilities | null;
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
    onNavigate,
    usageMeter,
    defaultProviderCapabilities,
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
                  ariaLabel="Reasoning effort"
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
                  ariaLabel="Max concurrency"
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
          // Run-ceiling caveat (issue #313, completing #296 item 5): the default
          // provider (e.g. Codex) may not enforce these ceilings at all. The
          // controls stay live — they're honored for a provider that DOES support
          // them — this is purely informational. `null` (Claude, or capabilities
          // still loading) renders nothing extra.
          note: runCeilingCaveatFor(defaultProviderCapabilities) ?? undefined,
        },
      ];
    case 'permissions':
      return buildPermissionsCards(settings, effective, patchScoped, patchGlobal);
    case 'constitution':
      // The Constitution editor is fully interactive (load/edit/save + regenerate),
      // so it renders outside the presentational `SettingsCard` set — like the MCP
      // servers card. No presentational rows here.
      return [];
    case 'automode':
      return buildAutoModeCards(settings, patchGlobal, onNavigate);
    case 'usage':
      return buildUsageCards(settings, patchGlobal, usageMeter);
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
                  ariaLabel="Default run mode"
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
              globalScoped: true,
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
              globalScoped: true,
              control: (
                <Segmented
                  ariaLabel="Open in editor"
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
    case 'terminal':
      return buildTerminalCards(settings, patchGlobal);
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
                  ariaLabel="Provider"
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
                <span className="flex items-center gap-2 text-xs-plus font-semibold text-success">
                  <StatusDot colorClass="bg-success" glow />
                  {settings.provider === 'codex' ? 'Codex default' : 'Claude default'}
                </span>
              ),
            },
          ],
        },
      ];
    case 'mcp':
      // The MCP servers card is fully interactive (its own editor modal + remove
      // confirm), so it renders outside the presentational `SettingsCard` set —
      // like the Constitution editor. No presentational rows here.
      return [];
    case 'notifications':
      return buildNotificationCards(settings, patchGlobal);
    case 'github':
      return buildGithubCards(settings, patchGlobal);
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
      return buildAboutCards(
        appInfo,
        onRestartOnboarding,
        ctx.isAppIdle,
        settings,
        patchGlobal,
      );
  }
}
