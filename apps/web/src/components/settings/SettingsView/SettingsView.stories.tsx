import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { Settings } from '@/lib/bridge';
import { SettingsView } from './SettingsView';

const settings: Settings = {
  defaultModel: 'opus-4.8',
  defaultEffort: 'high',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  theme: 'cosmic',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  projectOverrides: {
    nightcore: { defaultModel: 'haiku-4.5' },
  },
};

const meta = {
  title: 'Settings/SettingsView',
  component: SettingsView,
  parameters: { layout: 'fullscreen' },
  args: {
    settings,
    activeProjectId: 'nightcore',
    activeProjectName: 'nightcore',
    activeProjectPath: '~/dev/nightcore',
    onUpdate: fn(),
  },
} satisfies Meta<typeof SettingsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Global: Story = {};

export const NoActiveProject: Story = {
  args: { activeProjectId: null, activeProjectName: null },
};

/** Play test: the left nav switches to a presentational M2 page. */
export const NavigateToWorktrees: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /git worktrees/i }));
    await expect(canvas.getByText('Worktree isolation')).toBeInTheDocument();
  },
};
