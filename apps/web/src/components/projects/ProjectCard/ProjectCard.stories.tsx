import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ProjectCard } from './ProjectCard';
import type { ProjectSummary } from './ProjectCard.types';

const base: ProjectSummary = {
  id: 'nightcore',
  name: 'nightcore',
  path: '~/dev/nightcore',
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
  args: { project: base, onOpen: fn(), onMenu: fn() },
} satisfies Meta<typeof ProjectCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {};

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
