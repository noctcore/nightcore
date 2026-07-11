import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { Settings } from '@/lib/bridge';

import { SettingsView } from './SettingsView';

const settings: Settings = {
  defaultModel: 'claude-opus-4-8',
  defaultEffort: 'high',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  provider: 'claude',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  notifyOnAwaitingInput: true,
  defaultRunMode: 'main',
  maxTurns: null,
  maxBudgetUsd: null,
  mcpServers: [],
  contextPackEnabled: true,
  autoCommitOnVerified: false,
  sandboxSessions: false,
  issueSyncEnabled: false,
  sidebarStyle: 'unified',
  preferredEditor: null,
  terminalWebglEnabled: false,
  terminalConfinedDefault: false,
  terminalFontSize: null,
  terminalScrollback: null,
  usageMeterEnabled: false,
  autoPauseUsageThreshold: 90,
  terminalYoloLaunch: false,
  terminalDaemonEnabled: false,
  terminalAiNaming: false,
  terminalBellNotify: true,
  projectOverrides: {
    nightcore: { defaultModel: 'claude-haiku-4-5' },
  },
};

const meta = {
  title: 'Settings/SettingsView',
  component: SettingsView,
  parameters: { layout: 'fullscreen' },
  // The Notifications card's Claude notify-hook affordance uses `useToast` (T11); the
  // real app provides a ToastProvider at the shell root, so the story mirrors it.
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
  args: {
    settings,
    activeProjectId: 'nightcore',
    activeProjectName: 'nightcore',
    activeProjectPath: '~/dev/nightcore',
    onUpdate: fn(),
    onRestartOnboarding: fn(),
  },
} satisfies Meta<typeof SettingsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Global: Story = {};

export const NoActiveProject: Story = {
  args: { activeProjectId: null, activeProjectName: null },
};

/** Play test: the left nav switches to the live Worktrees page (run mode +
 *  cleanup toggle). */
export const NavigateToWorktrees: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /git worktrees/i }));
    await expect(canvas.getByText('Worktree isolation')).toBeInTheDocument();
    await expect(
      canvas.getByRole('switch', { name: /delete worktree on merge/i }),
    ).toBeInTheDocument();
  },
};

/** Play test: committing a Max-turns ceiling patches the global guardrail. */
export const SetMaxTurns: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('spinbutton', { name: 'Max turns' });
    await userEvent.type(input, '120');
    await userEvent.tab();
    await expect(args.onUpdate).toHaveBeenCalledWith({ maxTurns: 120 });
  },
};

/** Play test: toggling native notifications patches the global setting. */
export const ToggleNotifications: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /hooks & notifications/i }));
    await userEvent.click(
      canvas.getByRole('switch', { name: /native notifications on task complete/i }),
    );
    await expect(args.onUpdate).toHaveBeenCalledWith({ notifyOnComplete: true });
  },
};

/** Play test: the About page can re-open the onboarding flow. */
export const RestartOnboarding: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /about/i }));
    await userEvent.click(canvas.getByRole('button', { name: /run onboarding/i }));
    await expect(args.onRestartOnboarding).toHaveBeenCalled();
  },
};
