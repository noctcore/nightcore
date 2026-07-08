import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ProjectCard } from './ProjectCard';
import type { ProjectSummary } from './ProjectCard.types';

const base: ProjectSummary = {
  id: 'nightcore',
  name: 'nightcore',
  path: '~/dev/nightcore',
  icon: 'FolderCode',
  customIconPath: null,
  running: true,
  stats: [
    { label: 'tasks', value: 12, tone: 'neutral' },
    { label: 'done', value: 8, tone: 'success' },
    { label: 'failed', value: 1, tone: 'warning' },
  ],
  activity: 'active 3m ago',
};

const meta = {
  title: 'Projects/ProjectCard',
  component: ProjectCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
  args: { project: base, onOpen: fn(), onEdit: fn(), onDelete: fn() },
} satisfies Meta<typeof ProjectCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {};

/** Play test: the kebab opens a menu with Rename + Remove. */
export const Menu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Project menu' }));
    await expect(canvas.getByRole('menuitem', { name: /edit project/i })).toBeInTheDocument();
    await expect(canvas.getByRole('menuitem', { name: /remove/i })).toBeInTheDocument();
  },
};

/** Play test: Remove opens a confirmation that clarifies files are kept. */
export const ConfirmRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Project menu' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: /remove/i }));
    await expect(canvas.getByRole('alertdialog', { name: /remove project/i })).toBeInTheDocument();
  },
};

export const Idle: Story = {
  args: {
    project: {
      ...base,
      id: 'automaker',
      name: 'automaker (legacy)',
      path: '~/dev/automaker',
      running: false,
      activity: 'last run 2d ago',
    },
  },
};
