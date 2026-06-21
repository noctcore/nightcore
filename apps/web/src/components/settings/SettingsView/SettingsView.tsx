import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { SettingsCard } from '../SettingsCard';
import { useSettingsView } from './SettingsView.hooks';
import type { SettingsScope, SettingsViewProps } from './SettingsView.types';

const MODELS: [value: string, label: string][] = [
  ['opus-4.8', 'Opus'],
  ['sonnet-4.6', 'Sonnet'],
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

const SCOPE_TABS: [value: SettingsScope, label: string][] = [
  ['global', 'Global'],
  ['project', 'This project'],
];

/** The Settings surface, wired to live settings. The four run-shaping controls
 *  persist (global or per-project per the scope tab); the M2/M3 controls stay
 *  visible but disabled and roadmap-badged. */
export function SettingsView({
  settings,
  activeProjectId,
  activeProjectName,
  onUpdate,
}: SettingsViewProps) {
  const { scope, setScope, projectScopeEnabled, effective, patchScoped } =
    useSettingsView({ settings, activeProjectId, onUpdate });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[800px] px-[38px] pb-[60px] pt-[30px]">
        <div className="mb-6 flex items-center gap-3.5">
          <h1 className="text-[25px] font-semibold tracking-tight">Settings</h1>
          <div className="ml-auto inline-flex rounded-lg border border-border bg-black/20 p-0.5">
            {SCOPE_TABS.map(([v, label]) => {
              const disabled = v === 'project' && !projectScopeEnabled;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={disabled}
                  onClick={() => setScope(v)}
                  title={
                    disabled ? 'Activate a project to set per-project overrides' : undefined
                  }
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    v === scope
                      ? 'bg-primary/[0.18] text-primary'
                      : 'text-muted-foreground enabled:hover:text-foreground'
                  }`}
                >
                  {v === 'project' && activeProjectName !== null ? activeProjectName : label}
                </button>
              );
            })}
          </div>
        </div>

        <SettingsCard
          icon="✦"
          title="Models & runs"
          subtitle="Defaults applied to newly created tasks unless overridden per-task."
          rows={[
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
          ]}
        />

        <SettingsCard
          icon="⚡"
          title="Autonomy"
          subtitle="The auto-loop and concurrency land in M2; these values persist now."
          badge="M2"
          rows={[
            {
              label: 'Auto mode',
              hint: 'Continuously pick up eligible tasks',
              control: <RoadmapToggle on={false} />,
            },
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
            {
              label: 'Delete worktree on complete',
              hint: 'Remove the worktree after a task is merged',
              control: <RoadmapToggle on={settings.cleanupWorktrees} />,
            },
          ]}
        />

        <SettingsCard
          icon="🔒"
          title="Permissions"
          subtitle="How the agent is allowed to act. Interactive approval arrives in M3."
          badge="M3"
          rows={[
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
          ]}
        />

        <SettingsCard
          icon="🔔"
          title="Notifications"
          subtitle="React to task completions. Delivery lands in M3; the toggle persists."
          badge="M3"
          rows={[
            {
              label: 'Notify on complete',
              hint: 'Native notification when a task finishes',
              control: <RoadmapToggle on={settings.notifyOnComplete} />,
            },
          ]}
        />

        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge tone="neutral">i</Badge>
          {scope === 'project'
            ? 'These values override the global defaults for the active project only.'
            : 'Changes apply to new runs. Active agents keep their current model.'}
        </div>
      </div>
    </div>
  );
}
