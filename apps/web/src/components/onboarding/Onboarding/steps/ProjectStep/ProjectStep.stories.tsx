import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { OnboardingProps, OnboardingViewState } from '../../Onboarding.types';
import { ProjectStep } from './ProjectStep';

const props: OnboardingProps = {
  folder: '/Users/shirone/Documents/Projects/nightcore',
  gitState: 'valid',
  onChooseFolder: fn(),
  onInitGit: fn(),
  onCreateProject: fn(async () => {}),
  onSkip: fn(),
  onComplete: fn(),
};

const view: OnboardingViewState = {
  step: 'project',
  checks: null,
  checksLoading: false,
  checksError: null,
  appVersion: '0.2.0',
  projectName: 'nightcore',
  creating: false,
  canContinue: true,
  canCreateProject: true,
  envReady: true,
  goBack: fn(),
  goNext: fn(),
  rerunChecks: fn(),
  setProjectName: fn(),
  createProject: fn(),
};

const meta = {
  title: 'Onboarding/Steps/ProjectStep',
  component: ProjectStep,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[620px] bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: { props, view },
} satisfies Meta<typeof ProjectStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FolderSelected: Story = {};

export const Empty: Story = {
  args: {
    props: { ...props, folder: null, gitState: 'unknown' },
    view: { ...view, projectName: '', canCreateProject: false },
  },
};
