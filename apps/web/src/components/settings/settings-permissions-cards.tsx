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

/** OS write-containment modes (T16 / #157). `auto` is the STAGED default — Rust
 *  (`Settings::sandbox_writes_for`) is the authority for what Auto resolves to per
 *  run, so this control never re-derives it; it only distinguishes "no preference"
 *  from the two explicit, durable choices. */
const SANDBOX_MODES: [value: string, label: string][] = [
  ['auto', 'Auto'],
  ['always', 'Always'],
  ['never', 'Never'],
];

/** The stored tri-state → the selected segment. `null` (no preference) ⇒ Auto. */
function sandboxModeOf(stored: boolean | null): string {
  if (stored === null) return 'auto';
  return stored ? 'always' : 'never';
}

/** The selected segment → the patch value. A present `null` RESETS to Auto (the
 *  Rust patch field is a double option, so `null` clears rather than being ignored). */
const SANDBOX_PATCH: Record<string, boolean | null> = {
  auto: null,
  always: true,
  never: false,
};

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
          field: 'permissionMode',
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
          label: 'Sandbox agent writes (OS containment)',
          hint: 'Blocks the agent\'s shell commands from writing outside the task workspace, and hides cloud/SSH credentials from them, at the OS layer. Auto turns it on for macOS worktree runs — the isolated ones — and off elsewhere. Always/Never is a durable choice no future default change will flip. Where the OS cannot provide containment the run says so instead of quietly continuing.',
          field: 'sandboxSessions',
          control: (
            // Global-only (like Delete-on-merge): OS containment is a machine-level
            // guarantee, not a per-project preference. Tri-state so the staged
            // default (T16 / #157) and an explicit user choice stay distinguishable —
            // picking Never is the durable opt-out, and it survives a later widening.
            <Segmented
              ariaLabel="Sandbox agent writes"
              options={SANDBOX_MODES}
              value={sandboxModeOf(settings.sandboxSessions)}
              onChange={(v) => patchGlobal({ sandboxSessions: SANDBOX_PATCH[v] })}
            />
          ),
        },
        {
          label: 'Skip Claude permissions (YOLO)',
          hint: 'WARNING: adds --dangerously-skip-permissions to the terminal "Launch Claude" command — the agent then runs with NO permission prompts, as you, outside the gates. Off by default; enable only in a throwaway or fully trusted repo.',
          field: 'terminalYoloLaunch',
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
          field: 'planGateDefault',
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
