/** Permissions settings cards — split from settings-cards to stay under the file-size
 *  ratchet. Tool-access mode + sandbox + the "Skip Claude permissions (YOLO)" toggle
 *  (a security/governance control, moved here from Interface→Terminal since it strips
 *  every permission prompt rather than shaping layout), plus the plan-approval gate. */
import { ChecksIcon, LockIcon, Segmented, Toggle } from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';
import type { EffectiveSettings } from './SettingsView/SettingsView.hooks';

/** Selectable permission modes as `[value, label]` pairs. */
const PERMISSION_MODES: [value: string, label: string][] = [
  ['auto-accept', 'Auto'],
  ['plan', 'Plan'],
  ['ask', 'Ask'],
];

/** Build the Permissions page cards: tool access (incl. YOLO) + the plan-approval gate. */
export function buildPermissionsCards(
  settings: Settings,
  effective: EffectiveSettings,
  patchScoped: (patch: SettingsPatch) => void,
  patchGlobal: (patch: SettingsPatch) => void,
): SettingsCardProps[] {
  return [
    {
      icon: <LockIcon size={18} />,
      title: 'Tool permissions',
      subtitle: 'How the agent is allowed to act during a run.',
      rows: [
        {
          label: 'Permission mode',
          hint: 'How the agent handles a tool that needs permission: Auto runs it, Plan proposes a plan for your approval first, and Ask pauses for you (the runtime still auto-denies anything unsafe).',
          control: (
            <Segmented
              ariaLabel="Permission mode"
              options={PERMISSION_MODES}
              value={effective.permissionMode}
              onChange={(v) => patchScoped({ permissionMode: v })}
            />
          ),
        },
        {
          label: 'Sandbox agent writes (macOS, experimental)',
          hint: 'Block file writes outside the task workspace at the OS layer',
          globalScoped: true,
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
        {
          label: 'Skip Claude permissions (YOLO)',
          hint: 'WARNING: adds --dangerously-skip-permissions to the terminal "Launch Claude" command — the agent then runs with NO permission prompts, as you, outside the gates. Off by default; enable only in a throwaway or fully trusted repo.',
          globalScoped: true,
          hazard: true,
          hazardActive: settings.terminalYoloLaunch,
          control: (
            <Toggle
              on={settings.terminalYoloLaunch}
              onChange={(next) => patchGlobal({ terminalYoloLaunch: next })}
              label="Skip Claude permissions in the terminal Launch-Claude command"
            />
          ),
        },
      ],
    },
    {
      icon: <ChecksIcon size={18} />,
      title: 'Plan-approval gate',
      subtitle:
        'Build tasks produce a reviewable plan and wait for your approval before writing code.',
      rows: [
        {
          label: 'Plan before code (Build tasks)',
          hint: 'New Build tasks default to planning first — approve, refine, or reject. A per-task "Plan first" toggle overrides it.',
          globalScoped: true,
          control: (
            // Global-only (like the OS-sandbox toggle): a studio-wide governance
            // stance, not a per-project preference.
            <Toggle
              on={settings.planGateDefault}
              onChange={(next) => patchGlobal({ planGateDefault: next })}
              label="Plan before code for Build tasks"
            />
          ),
        },
      ],
    },
  ];
}
