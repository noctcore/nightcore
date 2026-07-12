/** About settings cards — split from settings-cards for file-size ratchet. */
import { BookIcon, Button, GearIcon, Pill, RepoLink, Segmented } from '@/components/ui';
import type { AppInfo, Settings, SettingsPatch } from '@/lib/bridge';
import { DEFAULT_REPO_URL } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';
import { UpdateChecker } from './UpdateChecker';

/** The Rust-core log-verbosity choices as `[value, label]` pairs — the exact wire
 *  vocabulary of the generated `LogLevel`, ordered quietest → most verbose (#245). */
const LOG_LEVELS: [value: string, label: string][] = [
  ['error', 'Error'],
  ['warn', 'Warn'],
  ['info', 'Info'],
  ['debug', 'Debug'],
  ['trace', 'Trace'],
];

/** Build the About page cards. */
export function buildAboutCards(
  appInfo: AppInfo | null,
  onRestartOnboarding: () => void,
  isAppIdle: boolean,
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
): SettingsCardProps[] {
  const version = appInfo?.version ?? '—';
  const repo = appInfo?.repository ?? DEFAULT_REPO_URL;
  const repoLabel = repo.replace(/^https?:\/\//, '');
  return [
    {
      icon: <BookIcon size={18} />,
      title: 'Nightcore',
      subtitle: 'Autonomous Claude dev studio — a rewrite of AutoMaker.',
      rows: [
        { label: 'Version', control: <Pill>v{version}</Pill> },
        {
          label: 'Updates',
          hint: 'Check GitHub Releases for a newer build.',
          control: <UpdateChecker isAppIdle={isAppIdle} />,
        },
        { label: 'Repository', hint: repoLabel, control: <RepoLink href={repo} /> },
        {
          label: 'Onboarding',
          hint: 'Run the setup checklist and project picker again.',
          control: (
            <Button variant="secondary" onClick={onRestartOnboarding}>
              Run onboarding
            </Button>
          ),
        },
      ],
    },
    {
      icon: <GearIcon size={18} />,
      title: 'Diagnostics',
      subtitle: 'Verbosity of the desktop core log (colored console + rolling log file).',
      rows: [
        {
          label: 'Log level',
          hint: 'How much the Rust core logs. Applies immediately; RUST_LOG, when set, overrides it.',
          stacked: true,
          control: (
            <Segmented
              ariaLabel="Log level"
              options={LOG_LEVELS}
              value={settings.logLevel}
              onChange={(v) => patchGlobal({ logLevel: v as Settings['logLevel'] })}
            />
          ),
        },
      ],
    },
  ];
}
