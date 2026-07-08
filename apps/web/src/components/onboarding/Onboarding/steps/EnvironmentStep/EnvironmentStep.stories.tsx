import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { OnboardingViewState } from '../../Onboarding.types';
import { EnvironmentStep } from './EnvironmentStep';

const checks: NonNullable<OnboardingViewState['checks']> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    authenticated: true,
    path: '/usr/local/bin/claude',
    version: 'claude 3.9.2',
    detail: 'authenticated',
    fixHint: 'Install Claude Code, then authenticate it.',
    fixCommand: 'claude auth login',
  },
  gh: {
    id: 'gh',
    label: 'GitHub CLI',
    installed: true,
    authenticated: true,
    path: '/usr/local/bin/gh',
    version: 'gh version 2.86.0',
    detail: 'Logged in to github.com',
    fixHint: 'Install GitHub CLI, then authenticate it.',
    fixCommand: 'gh auth login',
  },
  git: {
    id: 'git',
    label: 'Git',
    installed: true,
    authenticated: null,
    path: '/usr/bin/git',
    version: 'git version 2.50.0',
    detail: 'git version 2.50.0',
    fixHint: 'Install Git and make sure it is available on PATH.',
    fixCommand: 'git --version',
  },
};

const readyView: OnboardingViewState = {
  step: 'environment',
  checks,
  checksLoading: false,
  checksError: null,
  appVersion: '0.2.0',
  projectName: '',
  creating: false,
  canContinue: true,
  canCreateProject: false,
  envReady: true,
  goBack: fn(),
  goNext: fn(),
  rerunChecks: fn(),
  setProjectName: fn(),
  createProject: fn(),
};

const meta = {
  title: 'Onboarding/Steps/EnvironmentStep',
  component: EnvironmentStep,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[940px] bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: { view: readyView },
} satisfies Meta<typeof EnvironmentStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const ClaudeAuthMissing: Story = {
  args: {
    view: {
      ...readyView,
      envReady: false,
      checks: {
        ...checks,
        claude: {
          ...checks.claude,
          authenticated: false,
          detail: 'not logged in on this machine',
        },
      },
    },
  },
};
