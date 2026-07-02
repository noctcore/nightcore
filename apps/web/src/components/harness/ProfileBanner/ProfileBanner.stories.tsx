import type { Meta, StoryObj } from '@storybook/react-vite';

import type { RepoProfileVM } from '../harness.types';
import { ProfileBanner } from './ProfileBanner';

const PROFILE: RepoProfileVM = {
  isMonorepo: true,
  workspaceTool: 'bun',
  packages: [
    { name: '@nightcore/web', path: 'apps/web', role: 'app' },
    { name: '@nightcore/contracts', path: 'packages/contracts', role: 'package' },
  ],
  languages: ['typescript', 'rust'],
  frameworks: ['react', 'tauri'],
  hasEslintFlatConfig: true,
  hasLintMeta: true,
  hasAgentDocs: false,
  existingPlugins: ['@nightcore/eslint-plugin'],
};

const meta = {
  title: 'Harness/ProfileBanner',
  component: ProfileBanner,
  args: {
    profile: PROFILE,
    loading: false,
  },
} satisfies Meta<typeof ProfileBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Loading: Story = {
  args: { profile: null, loading: true },
};
