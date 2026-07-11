/** Notifications settings card (T11) — split from settings-cards to stay under the
 *  file-size ratchet, mirroring settings-github-cards / settings-interface-cards. The
 *  desktop-notification toggles (task complete, awaiting-input parks, terminal command
 *  completion) plus the one-click Claude notify-hook installer. */
import { BellIcon, Toggle } from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';

import { ClaudeNotifyHook } from './ClaudeNotifyHook';
import type { SettingsCardProps } from './SettingsCard';

/** Build the Notifications card: the three desktop-notification toggles and the
 *  clipboard-copy Claude notify-hook affordance. All toggles are global-only. */
export function buildNotificationCards(
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
): SettingsCardProps[] {
  return [
    {
      icon: <BellIcon size={18} />,
      title: 'Notifications',
      subtitle: 'Desktop notifications for task, run, and terminal events.',
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
        {
          label: 'Terminal command completion',
          hint: 'Notify when a shell command finishes in an unfocused terminal',
          control: (
            <Toggle
              on={settings.terminalBellNotify}
              onChange={(next) => patchGlobal({ terminalBellNotify: next })}
              label="Native notifications on terminal command completion"
            />
          ),
        },
        {
          label: 'Claude notify hook',
          hint: 'Copy a Claude Code Stop hook so a run in a Nightcore terminal pings you when it finishes',
          control: <ClaudeNotifyHook />,
        },
      ],
    },
  ];
}
