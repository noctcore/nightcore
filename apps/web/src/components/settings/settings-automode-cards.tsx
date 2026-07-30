/** Auto Mode settings cards (AUTOMATION group) — split from settings-cards to stay
 *  under the file-size ratchet, mirroring settings-github-cards. The board-header
 *  Auto Mode gear popover (`AutoModeOptions`) edits the same `autoCommitOnVerified`
 *  field and stays as a shortcut; this page is the discoverable, non-ephemeral home. */
import { BoltIcon, Button, Toggle } from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';
import type { SettingsPage } from './SettingsView/SettingsView.types';

/** Build the Auto Mode page cards: the auto-commit toggle, plus a cross-link to the
 *  plan-approval gate (kept on Permissions, next to the other governance controls,
 *  rather than duplicated here). */
export function buildAutoModeCards(
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
  onNavigate: (page: SettingsPage) => void,
): SettingsCardProps[] {
  return [
    {
      icon: <BoltIcon size={18} />,
      title: 'Auto Mode',
      subtitle: 'Automatic actions the autonomous loop takes as it runs.',
      rows: [
        {
          label: 'Auto-commit on verified',
          hint: 'While Auto Mode runs, each task is committed automatically the moment it’s verified — before the next one starts. In a shared (main) checkout, run one task at a time so per-task commits stay clean.',
          field: 'autoCommitOnVerified',
          control: (
            <Toggle
              on={settings.autoCommitOnVerified}
              onChange={(next) => patchGlobal({ autoCommitOnVerified: next })}
              label="Auto-commit on verified"
            />
          ),
        },
        {
          label: 'Plan before code (Build tasks)',
          hint: 'The plan-approval gate governs new Build tasks. Configured on the Permissions page, next to the other tool-access controls.',
          control: (
            <Button variant="ghost" onClick={() => onNavigate('permissions')}>
              Open Permissions
            </Button>
          ),
        },
      ],
    },
  ];
}
