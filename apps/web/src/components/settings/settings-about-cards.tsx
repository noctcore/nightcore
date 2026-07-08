/** About settings cards — split from settings-cards for file-size ratchet. */
import { BookIcon, Button, Pill, RepoLink } from '@/components/ui';
import type { AppInfo } from '@/lib/bridge';
import { DEFAULT_REPO_URL } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';

/** Build the About page cards. */
export function buildAboutCards(
  appInfo: AppInfo | null,
  onRestartOnboarding: () => void,
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
  ];
}
